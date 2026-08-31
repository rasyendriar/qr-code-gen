import pandas as pd
import qrcode
import qrcode.image.svg
import os
import argparse
from concurrent.futures import ProcessPoolExecutor, as_completed
import time
from pathlib import Path
import math
import base64
import io
from PIL import Image

# Default configuration for the QR code generation
DEFAULT_OUTPUT_DIR = "generated_qrcodes"
# Error correction level (High is recommended for small/etched QR codes)
# ERROR_CORRECT_H (High): ~30% error correction, good for damage resistance
ERROR_CORRECTION = qrcode.constants.ERROR_CORRECT_H
# Size of each 'box' (pixel) in the QR code.
BOX_SIZE = 10
# Border thickness (minimum is usually 4)
BORDER = 4

def generate_single_qr(name_tag, url, output_dir, output_format="svg"):
    """
    Generates a single QR code and saves it to the output directory.
    
    Args:
        name_tag (str): The identifier for the QR code (used for the filename).
        url (str): The data to encode in the QR code.
        output_dir (Path): The directory to save the file.
        output_format (str): The format to save ('svg', 'png', or 'base64').
        
    Returns:
        tuple: (status_code, message, name_tag, base64_data)
            - status_code: 0 for success, 1 for error
            - message: success message or error details
            - name_tag: the sanitized identifier
            - base64_data: the base64 string (if base64 format is selected), else None
    """
    try:
        # Sanitize filename by removing potentially invalid characters
        safe_name = "".join([c for c in str(name_tag) if c.isalnum() or c in ('-', '_')]).strip()
        if not safe_name:
            return (1, f"Invalid or empty name tag: '{name_tag}'", name_tag, None)

        # Initialize the QR code generator with specific settings
        qr = qrcode.QRCode(
            version=1, # 1 is the smallest, will automatically scale up if data is large
            error_correction=ERROR_CORRECTION,
            box_size=BOX_SIZE,
            border=BORDER,
        )
        
        # Add the URL data
        qr.add_data(str(url))
        qr.make(fit=True)

        if output_format.lower() == "svg":
            # For 20x20mm etching, SVG (vector) is highly recommended as it's resolution-independent
            factory = qrcode.image.svg.SvgPathImage
            img = qr.make_image(image_factory=factory)
            file_path = output_dir / f"{safe_name}.svg"
            img.save(str(file_path))
            return (0, f"Success: {safe_name}.{output_format}", safe_name, None)
            
        elif output_format.lower() == "base64":
            # Generate PNG in memory and convert to base64 string
            img = qr.make_image(fill_color="black", back_color="white")
            buffer = io.BytesIO()
            img.save(buffer, format="PNG")
            img_str = base64.b64encode(buffer.getvalue()).decode("utf-8")
            base64_data = f"data:image/png;base64,{img_str}"
            return (0, f"Success: {safe_name} (Base64)", safe_name, base64_data)
            
        else:
            # PNG fallback, high box_size ensures it's high resolution before scaling
            img = qr.make_image(fill_color="black", back_color="white")
            file_path = output_dir / f"{safe_name}.png"
            img.save(str(file_path))
            return (0, f"Success: {safe_name}.{output_format}", safe_name, None)
    
    except Exception as e:
        return (1, f"Error generating QR for '{name_tag}': {str(e)}", name_tag, None)

def save_base64_image(name_tag, b64_string, output_dir, scale=10):
    """
    Takes a Base64 string (representing an image) and saves it as a PNG file.
    Upscales the image losslessly using Nearest Neighbor for high-resolution printing.
    """
    try:
        safe_name = "".join([c for c in str(name_tag) if c.isalnum() or c in ('-', '_')]).strip()
        if not safe_name:
            return (1, f"Invalid or empty name tag: '{name_tag}'", name_tag, None)

        # Clean the string if it contains the data URI prefix (e.g., "data:image/png;base64,")
        if "," in b64_string:
            b64_string = b64_string.split(",", 1)[1]

        # Decode the base64 string to binary image data
        image_data = base64.b64decode(b64_string)
        
        # Open with PIL and resize losslessly (Nearest Neighbor)
        img = Image.open(io.BytesIO(image_data))
        new_size = (img.size[0] * scale, img.size[1] * scale)
        
        # Use Image.Resampling.NEAREST for crisp edges (fallback to Image.NEAREST for older PIL)
        resample_filter = getattr(Image, 'Resampling', Image).NEAREST
        high_res_img = img.resize(new_size, resample_filter)
        
        # Save as high-res PNG
        file_path = output_dir / f"{safe_name}.png"
        high_res_img.save(str(file_path))
            
        return (0, f"Success: {safe_name}.png (Saved from Base64, Upscaled {scale}x)", safe_name, None)
        
    except Exception as e:
        return (1, f"Error decoding Base64 image for '{name_tag}': {str(e)}", name_tag, None)

def process_batch_chunk(chunk_data, output_dir, output_format, input_type, scale):
    """
    Processes a chunk of data (a list of tuples) to generate or save QR codes.
    This function runs in a separate process.
    """
    results = []
    for index, row in chunk_data.iterrows():
        # Assuming column 0 is name tag and column 1 is url/base64
        name_tag = row.iloc[0]
        data_val = row.iloc[1]
        
        # Skip empty rows if they somehow sneak in
        if pd.isna(name_tag) or pd.isna(data_val):
            results.append((1, f"Skipped row {index}: missing data", str(name_tag), None))
            continue
            
        if input_type == "base64_image":
            # Save the existing base64 image string as a file and scale it up
            result = save_base64_image(name_tag, str(data_val), output_dir, scale)
        else:
            # Generate a new QR code from the URL
            result = generate_single_qr(name_tag, data_val, output_dir, output_format)
            
        results.append(result)
    return results

def run_batch_converter(input_file, output_format="svg", workers=None, input_type="url", scale=10):
    """
    Main function to read the input file and orchestrate the parallel generation.
    """
    start_time = time.time()
    
    input_path = Path(input_file)
    if not input_path.exists():
        print(f"Error: Input file '{input_file}' not found.")
        return

    output_dir = Path(DEFAULT_OUTPUT_DIR)
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"Reading data from {input_file}...")
    
    try:
        # Check file extension to determine how to read it
        if input_path.suffix.lower() == '.csv':
            # Fast read for CSV
            df = pd.read_csv(input_path, header=None)
        elif input_path.suffix.lower() in ['.xls', '.xlsx']:
            # Read Excel
            df = pd.read_excel(input_path, header=None)
        else:
            print("Error: Unsupported file format. Please use .csv, .xls, or .xlsx")
            return
            
    except Exception as e:
        print(f"Error reading file: {str(e)}")
        return

    total_records = len(df)
    print(f"Successfully loaded {total_records} records.")
    
    if total_records == 0:
        print("No data found in file.")
        return

    # Determine number of workers. Use (CPU cores - 1) to leave one core free for OS tasks, 
    # but ensure at least 1 worker.
    if workers is None:
        max_workers = max(1, os.cpu_count() - 1)
    else:
        max_workers = int(workers)
        
    print(f"Starting generation using {max_workers} parallel workers...")
    print(f"Output directory: {output_dir.absolute()}")
    print(f"Output format: {output_format.upper()}")
    print(f"Input Data Type: {input_type.upper()}")
    print("-" * 50)

    # Chunk the dataframe to feed into workers
    # We divide the total records roughly equally among workers, or into smaller chunks
    # Chunk size of ~1000 is usually a good balance between overhead and memory
    chunk_size = min(1000, math.ceil(total_records / max_workers))
    chunks = [df[i:i + chunk_size] for i in range(0, total_records, chunk_size)]
    
    success_count = 0
    error_count = 0
    base64_results = []
    
    # Using ProcessPoolExecutor for CPU-bound tasks (generating images)
    with ProcessPoolExecutor(max_workers=max_workers) as executor:
        # Submit all chunks to the executor
        future_to_chunk = {
            executor.submit(process_batch_chunk, chunk, output_dir, output_format, input_type, scale): i 
            for i, chunk in enumerate(chunks)
        }
        
        # Process results as they complete
        processed_chunks = 0
        for future in as_completed(future_to_chunk):
            processed_chunks += 1
            try:
                results = future.result()
                for status, msg, name_tag, b64_data in results:
                    if status == 0:
                        success_count += 1
                        if b64_data:
                            base64_results.append({"name_tag": name_tag, "base64_qr": b64_data})
                    else:
                        error_count += 1
                        print(msg) # Print errors as they happen
                        
                # Progress update
                progress = (processed_chunks / len(chunks)) * 100
                print(f"Progress: {progress:.1f}% ({success_count} generated, {error_count} errors)", end="\r")
                
            except Exception as exc:
                print(f"\nChunk generated an exception: {exc}")

    end_time = time.time()
    duration = end_time - start_time
    
    print("\n" + "-" * 50)
    print("Batch Generation Complete!")
    print(f"Total processed: {total_records}")
    print(f"Successfully created: {success_count}")
    print(f"Errors: {error_count}")
    
    # If base64 format was selected, export all strings to a single CSV
    if output_format.lower() == "base64" and base64_results:
        output_csv = input_path.parent / f"{input_path.stem}_base64_output.csv"
        pd.DataFrame(base64_results).to_csv(output_csv, index=False)
        print(f"Base64 strings successfully saved to: {output_csv.absolute()}")

    print(f"Total time taken: {duration:.2f} seconds")
    if duration > 0:
        print(f"Average speed: {total_records / duration:.2f} QR codes/second")

if __name__ == "__main__":
    # Setup argparse for command line usage
    parser = argparse.ArgumentParser(description="Batch generate QR codes from CSV/Excel.")
    parser.add_argument("input_file", help="Path to the input CSV or Excel file.")
    parser.add_argument("-t", "--type", choices=["url", "base64_image"], default="url", dest="input_type",
                        help="Input data type in column 2. 'url' to generate QR from link, 'base64_image' to decode a base64 image string into a file.")
    parser.add_argument("-f", "--format", choices=["svg", "png", "base64"], default="svg", 
                        help="Output format (svg, png, or base64). Default is svg. (Ignored if type is base64_image)")
    parser.add_argument("-s", "--scale", type=int, default=10,
                        help="Scale multiplier for base64_image decoding to increase resolution (Default: 10).")
    parser.add_argument("-w", "--workers", type=int, default=None,
                        help="Number of parallel workers. Default is CPU cores - 1.")
    
    # Parse arguments
    args = parser.parse_args()
    
    # Run the main function
    run_batch_converter(args.input_file, args.format, args.workers, args.input_type, args.scale)
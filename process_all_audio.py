#!/usr/bin/env python3
"""
Script to process all audio files in the {path} directory using audio_diarization.py
"""
import os
import sys
import subprocess
from pathlib import Path

# Get the script directory
script_dir = Path(__file__).parent
# Updated path
data_dir = script_dir / "data" / "data_3"
backend_dir = script_dir / "backend"
audio_diarization_script = backend_dir / "audio_diarization.py"

def process_all_audio_files():
    """Process all audio files in the {path} directory."""
    
    if not audio_diarization_script.exists():
        print(f"❌ ERROR: audio_diarization.py not found at {audio_diarization_script}")
        sys.exit(1)
    
    if not data_dir.exists():
        print(f"❌ ERROR: {data_dir} directory not found at {data_dir}")
        print(f"   Please ensure the directory exists at: {data_dir.absolute()}")
        sys.exit(1)
    
    # Find all subdirectories in {path}/
    subdirs = [d for d in data_dir.iterdir() if d.is_dir()]
    subdirs.sort()  # Process in order
    
    total = len(subdirs)
    print(f"📁 Found {total} subdirectories to process\n")
    
    success_count = 0
    error_count = 0
    skipped_count = 0
    errors = []
    
    for idx, subdir in enumerate(subdirs, 1):
        audio_file = subdir / "audio.mp3"
        ref_text_file = subdir / "ref_text.txt"
        
        print(f"\n{'='*80}")
        print(f"[{idx}/{total}] Processing: {subdir.name}")
        print(f"{'='*80}")
        
        # Check if both files exist
        if not audio_file.exists():
            print(f"⚠️  WARNING: audio.mp3 not found in {subdir.name}")
            skipped_count += 1
            continue
        
        if not ref_text_file.exists():
            print(f"⚠️  WARNING: ref_text.txt not found in {subdir.name}")
            skipped_count += 1
            continue
        
        # Run the transcription command
        cmd = [
            "python3",
            str(audio_diarization_script),
            str(audio_file),
            "Gujarati",
            "English",
            str(ref_text_file)
        ]
        
        try:
            print(f"🎵 Processing audio: {audio_file}")
            print(f"📝 Using reference: {ref_text_file}")
            print(f"▶️  Running: {' '.join(cmd)}\n")
            
            result = subprocess.run(
                cmd,
                cwd=str(script_dir),
                capture_output=False,  # Show output in real-time
                text=True,
                check=True
            )
            
            print(f"\n✅ Successfully processed {subdir.name}")
            success_count += 1
            
        except subprocess.CalledProcessError as e:
            print(f"\n❌ ERROR processing {subdir.name}: {e}")
            error_count += 1
            errors.append((subdir.name, str(e)))
            
        except Exception as e:
            print(f"\n❌ Unexpected error processing {subdir.name}: {e}")
            error_count += 1
            errors.append((subdir.name, str(e)))
    
    # Print summary
    print(f"\n{'='*80}")
    print("📊 PROCESSING SUMMARY")
    print(f"{'='*80}")
    print(f"Total directories: {total}")
    print(f"✅ Successfully processed: {success_count}")
    print(f"❌ Errors: {error_count}")
    print(f"⚠️  Skipped: {skipped_count}")
    print(f"{'='*80}\n")
    
    if errors:
        print("❌ Files with errors:")
        for subdir_name, error_msg in errors:
            print(f"  - {subdir_name}: {error_msg}")
        print()
    
    return success_count, error_count, skipped_count

if __name__ == "__main__":
    try:
        success, errors, skipped = process_all_audio_files()
        sys.exit(0 if errors == 0 else 1)
    except KeyboardInterrupt:
        print("\n\n⚠️  Processing interrupted by user")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ Fatal error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


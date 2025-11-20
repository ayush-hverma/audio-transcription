#!/usr/bin/env python3
"""
Calculate the total duration of all audio files in the client_data directory.
"""
import os
from pathlib import Path
from utils.audio_utils import get_audio_duration

def find_audio_files(root_dir):
    """Find all audio files in the directory tree."""
    audio_extensions = {'.mp3', '.wav', '.m4a', '.flac', '.ogg', '.aac', '.wma'}
    audio_files = []
    
    root_path = Path(root_dir)
    for file_path in root_path.rglob('*'):
        if file_path.is_file() and file_path.suffix.lower() in audio_extensions:
            audio_files.append(file_path)
    
    return audio_files

def format_duration(seconds):
    """Format duration in a human-readable format."""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = seconds % 60
    
    parts = []
    if hours > 0:
        parts.append(f"{hours} hour{'s' if hours != 1 else ''}")
    if minutes > 0:
        parts.append(f"{minutes} minute{'s' if minutes != 1 else ''}")
    if secs > 0 or len(parts) == 0:
        parts.append(f"{secs:.2f} second{'s' if secs != 1 else ''}")
    
    return ", ".join(parts)

def main():
    client_data_dir = Path(__file__).parent / "client_data"
    
    if not client_data_dir.exists():
        print(f"Error: {client_data_dir} does not exist")
        return
    
    print(f"Scanning for audio files in {client_data_dir}...")
    audio_files = find_audio_files(client_data_dir)
    
    if not audio_files:
        print("No audio files found.")
        return
    
    print(f"\nFound {len(audio_files)} audio file(s)")
    print("Calculating durations...\n")
    
    total_duration = 0.0
    successful = 0
    failed = []
    
    for i, audio_file in enumerate(audio_files, 1):
        try:
            duration = get_audio_duration(str(audio_file))
            total_duration += duration
            successful += 1
            if i % 50 == 0 or i == len(audio_files):
                print(f"Processed {i}/{len(audio_files)} files... (Total so far: {format_duration(total_duration)})")
        except Exception as e:
            failed.append((audio_file, str(e)))
            print(f"Warning: Could not process {audio_file.name}: {e}")
    
    print("\n" + "="*60)
    print("SUMMARY")
    print("="*60)
    print(f"Total audio files found: {len(audio_files)}")
    print(f"Successfully processed: {successful}")
    if failed:
        print(f"Failed to process: {len(failed)}")
    print(f"\nTotal duration: {format_duration(total_duration)}")
    print(f"Total duration (seconds): {total_duration:.2f}")
    print(f"Total duration (hours): {total_duration / 3600:.2f}")
    
    if failed:
        print("\nFailed files:")
        for file_path, error in failed:
            print(f"  - {file_path}: {error}")

if __name__ == "__main__":
    main()


"""
Audio processing utility functions.
"""
import os
from pydub import AudioSegment


def extract_audio_clips(input_file, output_dir, timestamps, output_format="wav", clip_name_prefix="clip"):
    """
    Extract multiple audio clips from a source file based on timestamps.
    
    Args:
        input_file: Path to source audio file
        output_dir: Directory to save extracted clips
        timestamps: List of (start, end) tuples in seconds
        output_format: Output audio format (default: wav)
        clip_name_prefix: Prefix for output filenames
        
    Returns:
        List of paths to extracted audio clips
    """
    # Load the audio file
    audio = AudioSegment.from_file(input_file)
    
    clip_paths = []
    
    for i, (start, end) in enumerate(timestamps):
        # Convert seconds to milliseconds
        start_ms = int(start * 1000)
        end_ms = int(end * 1000)
        
        # Extract the segment
        clip = audio[start_ms:end_ms]
        
        # Create output filename
        clip_filename = f"{clip_name_prefix}_{i}_{start:.2f}s-{end:.2f}s.{output_format}"
        clip_path = os.path.join(output_dir, clip_filename)
        
        # Export the clip
        clip.export(clip_path, format=output_format)
        clip_paths.append(clip_path)
    
    return clip_paths


def get_audio_duration(audio_path):
    """
    Get the duration of an audio file in seconds.
    
    Args:
        audio_path: Path to audio file
        
    Returns:
        Duration in seconds
    """
    audio = AudioSegment.from_file(audio_path)
    return len(audio) / 1000.0


def convert_audio_format(input_path, output_path, output_format="wav"):
    """
    Convert audio file to a different format.
    
    Args:
        input_path: Path to input audio file
        output_path: Path to output audio file
        output_format: Desired output format
        
    Returns:
        Path to converted audio file
    """
    audio = AudioSegment.from_file(input_path)
    audio.export(output_path, format=output_format)
    return output_path


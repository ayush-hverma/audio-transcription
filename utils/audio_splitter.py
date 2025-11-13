"""
Audio splitting utility for processing large audio files in chunks.
"""
import os
from pydub import AudioSegment
from pathlib import Path


def split_audio(audio_path, chunk_duration_seconds=300, output_dir=None):
    """
    Split audio file into chunks of specified duration.
    
    Args:
        audio_path: Path to the audio file to split
        chunk_duration_seconds: Duration of each chunk in seconds (default: 300 = 5 minutes)
        output_dir: Directory to save chunks (default: same directory as input with _chunks suffix)
        
    Returns:
        Dictionary mapping chunk index to chunk file path
    """
    # Load the audio file
    audio = AudioSegment.from_file(audio_path)
    audio_duration_ms = len(audio)
    chunk_duration_ms = chunk_duration_seconds * 1000
    
    # Create output directory
    if output_dir is None:
        audio_dir = os.path.dirname(audio_path)
        audio_name = Path(audio_path).stem
        output_dir = os.path.join(audio_dir, f"{audio_name}_chunks")
    
    os.makedirs(output_dir, exist_ok=True)
    
    chunks_dict = {}
    chunk_index = 0
    
    # Split audio into chunks
    for start_ms in range(0, audio_duration_ms, chunk_duration_ms):
        end_ms = min(start_ms + chunk_duration_ms, audio_duration_ms)
        
        # Extract chunk
        chunk = audio[start_ms:end_ms]
        
        # Create chunk filename
        chunk_filename = f"chunk_{chunk_index:03d}.mp3"
        chunk_path = os.path.join(output_dir, chunk_filename)
        
        # Export chunk
        chunk.export(chunk_path, format="mp3")
        
        # Store in dictionary
        chunks_dict[chunk_index] = chunk_path
        
        chunk_index += 1
    
    return chunks_dict


def merge_audio_chunks(chunk_paths, output_path):
    """
    Merge audio chunks back into a single file.
    
    Args:
        chunk_paths: List of paths to audio chunks (in order)
        output_path: Path to output merged audio file
        
    Returns:
        Path to merged audio file
    """
    # Load first chunk
    merged_audio = AudioSegment.from_file(chunk_paths[0])
    
    # Append remaining chunks
    for chunk_path in chunk_paths[1:]:
        chunk = AudioSegment.from_file(chunk_path)
        merged_audio += chunk
    
    # Export merged audio
    merged_audio.export(output_path, format=os.path.splitext(output_path)[1][1:])
    
    return output_path


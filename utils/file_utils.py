"""
File utility functions for the transcription pipeline.
"""
import os
import json
import shutil


def ensure_dir(directory):
    """
    Create directory if it doesn't exist.
    
    Args:
        directory: Path to directory to create
    """
    if not os.path.exists(directory):
        os.makedirs(directory, exist_ok=True)


def save_json(data, output_path):
    """
    Save data to JSON file with proper formatting.
    
    Args:
        data: Dictionary or list to save
        output_path: Path to output JSON file
    """
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def load_json(input_path):
    """
    Load data from JSON file.
    
    Args:
        input_path: Path to input JSON file
        
    Returns:
        Loaded data
    """
    with open(input_path, 'r', encoding='utf-8') as f:
        return json.load(f)


def clear_gpu_memory():
    """
    Clear GPU memory (placeholder for PyTorch memory cleanup).
    """
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except ImportError:
        pass


def clean_temp_files(directory):
    """
    Remove temporary files from a directory.
    
    Args:
        directory: Path to directory to clean
    """
    if os.path.exists(directory):
        shutil.rmtree(directory)


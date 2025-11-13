"""
Configuration file for the transcription pipeline.
"""
import os

# Google Cloud credentials path
# Update this with your actual credentials file path
GOOGLE_APPLICATION_CREDENTIALS = os.environ.get(
    "GOOGLE_APPLICATION_CREDENTIALS",
    os.path.expanduser("/Users/ayush/Desktop/transcription/gcp-credentials_bkp.json")
)

# Language to script mapping
LANGUAGE_CODES = {
    "Gujarati": "Gujarati",
    "Hindi": "Devanagari",
    "English": "Latin",
    "Tamil": "Tamil",
    "Telugu": "Telugu",
    "Kannada": "Kannada",
    "Malayalam": "Malayalam",
    "Bengali": "Bengali",
    "Marathi": "Devanagari",
    "Punjabi": "Gurmukhi",
    "Urdu": "Arabic",
    "Odia": "Odia",
    "Assamese": "Bengali",
    "Sanskrit": "Devanagari",
}

# Audio processing settings
AUDIO_CHUNK_DURATION = 300  # seconds (5 minutes)
MAX_AUDIO_FILE_SIZE = 100 * 1024 * 1024  # 100 MB

# Model settings
DEFAULT_MODEL = "gemini-2.0-flash"
MAX_RETRIES = 5
BASE_RETRY_DELAY = 15.0
MAX_RETRY_DELAY = 300.0


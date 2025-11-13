"""
Multilingual Audio Transcription with Speaker Diarization and Emotion Detection

This module provides a flexible transcription system that supports multiple languages
using Gemini 2.5 Flash and Vertex AI.

Features:
- Support for any source language (set by user)
- Optional reference text for improved accuracy
- Phrase/sentence-level timestamps with speaker identification
- Emotion detection for each speech segment
- Proper script usage based on language
- JSON output format
- Automatic speaker diarization
- Handles long audio files through automatic chunking
"""

import os
import sys
import json
import time
from pathlib import Path
import re
import random
from typing import Optional, Dict, List, Tuple
from enum import Enum

# Add parent directory to path to import from utils and pipeline
sys.path.insert(0, str(Path(__file__).parent.parent))

from vertexai.generative_models import GenerativeModel, Part, GenerationConfig
from vertexai.preview.generative_models import SafetySetting
from pydub import AudioSegment
from concurrent.futures import ThreadPoolExecutor, as_completed

from utils.file_utils import ensure_dir, save_json
from utils.audio_splitter import split_audio
from pipeline.pipeline_config import GOOGLE_APPLICATION_CREDENTIALS

# Set Google credentials for authentication
os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = GOOGLE_APPLICATION_CREDENTIALS

# Configuration
AUDIO_CHUNKING_OFFSET = 300  # 5 minutes chunks
MODEL_NAME = "gemini-2.5-flash"


class SupportedLanguage(Enum):
    """Supported languages with their codes and native names"""
    HINDI = ("HIN", "Hindi", "हिन्दी", "Devanagari")
    BENGALI = ("BEN", "Bengali", "বাংলা", "Bengali Script")
    TAMIL = ("TAM", "Tamil", "தமிழ்", "Tamil Script")
    TELUGU = ("TEL", "Telugu", "తెలుగు", "Telugu Script")
    MARATHI = ("MAR", "Marathi", "मराठी", "Devanagari")
    GUJARATI = ("GUJ", "Gujarati", "ગુજરાતી", "Gujarati Script")
    KANNADA = ("KAN", "Kannada", "ಕನ್ನಡ", "Kannada Script")
    MALAYALAM = ("MAL", "Malayalam", "മലയാളം", "Malayalam Script")
    PUNJABI = ("PAN", "Punjabi", "ਪੰਜਾਬੀ", "Gurmukhi Script")
    URDU = ("URD", "Urdu", "اردو", "Perso-Arabic Script")
    ENGLISH = ("ENG", "English", "English", "Latin Script")
    HINGLISH = ("HINGLISH", "Hinglish", "Hinglish (हिन्दी-English)", "Mixed Script")
    
    def __init__(self, code, english_name, native_name, script):
        self.code = code
        self.english_name = english_name
        self.native_name = native_name
        self.script = script


def get_language_config(language_input: str) -> Tuple[str, str, str, str]:
    """
    Get language configuration by code or name (case-insensitive).
    
    Args:
        language_input: Language code (e.g., 'HIN', 'BEN') or name (e.g., 'Hindi', 'Bengali', 'Hinglish')
    
    Returns:
        Tuple of (code, english_name, native_name, script)
    """
    language_input = language_input.strip().upper()
    
    # Try to match by code or English name
    for lang in SupportedLanguage:
        if lang.code == language_input or lang.english_name.upper() == language_input:
            return lang.code, lang.english_name, lang.native_name, lang.script
    
    # If not found in supported languages, return generic config
    print(f"⚠️  Warning: Language '{language_input}' not found in supported languages. Using as-is.")
    return language_input, language_input, language_input, "Native Script"


def retry_with_backoff(func, max_retries=5, base_delay=15.0, max_delay=300.0, *args, **kwargs):
    """Retry a function with exponential backoff."""
    for attempt in range(max_retries):
        try:
            return func(*args, **kwargs)
        except Exception as e:
            if attempt == max_retries - 1:
                raise
            delay = min(max_delay, base_delay * (2 ** attempt))
            jitter = random.uniform(0, delay * 0.1)
            total_delay = delay + jitter
            print(f"⚠️ Attempt {attempt + 1} failed: {str(e)}. Retrying in {total_delay:.1f}s...")
            time.sleep(total_delay)


def timestamp_to_seconds(timestamp: str) -> float:
    """Convert timestamp string like 'HH:MM:SS:mmm' to seconds."""
    parts = timestamp.split(":")
    if len(parts) == 4:  # HH:MM:SS:mmm
        hours, minutes, seconds, milliseconds = parts
        return int(hours) * 3600 + int(minutes) * 60 + int(seconds) + int(milliseconds) / 1000.0
    elif len(parts) == 3:  # HH:MM:SS or MM:SS.mmm (legacy support)
        if '.' in parts[2]:
            minutes, seconds = parts[1], parts[2]
            return int(parts[0]) * 3600 + int(minutes) * 60 + float(seconds)
        else:
            hours, minutes, seconds = parts
            return int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    else:  # MM:SS.mmm (legacy)
        minutes, seconds = parts
        return int(minutes) * 60 + float(seconds)


def seconds_to_timestamp(seconds: float) -> str:
    """Convert seconds to timestamp string like 'HH:MM:SS:mmm'."""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    milliseconds = int((seconds % 1) * 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}:{milliseconds:03d}"


def deduplicate_entries(items: List[Dict]) -> List[Dict]:
    """Remove duplicate entries with the same timestamps."""
    seen = set()
    deduplicated = []
    
    for item in items:
        key = (item.get('start'), item.get('end'))
        if key not in seen:
            seen.add(key)
            deduplicated.append(item)
    
    return deduplicated


def safe_extract_json(content: str) -> List[Dict]:
    """Extract and parse JSON from model response."""
    # Try to find JSON block
    json_match = re.search(r'```json\s*(.*?)```', content, re.DOTALL)
    
    if not json_match:
        # Try without closing backticks (truncated response)
        json_match = re.search(r'```json\s*(.*)', content, re.DOTALL)
        if not json_match:
            raise ValueError("No JSON block found in content.")
    
    json_str = json_match.group(1).strip()
    
    # Handle incomplete JSON
    if not json_str.endswith(']'):
        last_complete = json_str.rfind('}')
        if last_complete != -1:
            json_str = json_str[:last_complete + 1]
            if not json_str.endswith(']'):
                json_str += '\n]'
    
    # Ensure proper JSON array format
    if not (json_str.startswith('[') and json_str.endswith(']')):
        json_str = f"[{json_str}]"
    
    # Remove trailing commas
    json_str = re.sub(r',\s*([\]}])', r'\1', json_str)
    
    try:
        json_data = json.loads(json_str)
    except json.JSONDecodeError as e:
        print(f"❌ JSON parsing error: {e}")
        raise ValueError(f"Failed to parse JSON: {e}")
    
    # Validate and clean data
    valid_items = []
    for item in json_data:
        required_fields = ["start", "end", "text", "speaker", "language", "emotion", "end_of_speech"]
        if not all(k in item for k in required_fields):
            print(f"⚠️ Warning: Skipping invalid item (missing fields): {item}")
            continue
        valid_items.append(item)
    
    if not valid_items:
        raise ValueError("No valid items found in JSON data")
    
    return deduplicate_entries(valid_items)


def merge_json_with_offset(data: Dict[int, List[Dict]], time_offset: int) -> List[Dict]:
    """
    Merge multiple JSON arrays and apply time offset for each chunk.
    
    Args:
        data: Dictionary where keys are chunk indices and values are JSON arrays
        time_offset: Time in seconds to offset for each chunk
    
    Returns:
        Merged and time-adjusted JSON array
    """
    merged_array = []
    sorted_data = sorted(data.items(), key=lambda x: x[0])
    
    for i, json_array in sorted_data:
        offset_seconds = i * time_offset
        for entry in json_array:
            new_entry = entry.copy()
            new_entry['start'] = seconds_to_timestamp(
                timestamp_to_seconds(entry['start']) + offset_seconds
            )
            new_entry['end'] = seconds_to_timestamp(
                timestamp_to_seconds(entry['end']) + offset_seconds
            )
            merged_array.append(new_entry)
    
    return merged_array


def build_transcription_prompt(language_code: str, language_name: str, 
                               native_name: str, script_name: str,
                               reference_text: Optional[str] = None) -> str:
    """
    Build a comprehensive transcription prompt for the specified language.
    
    Args:
        language_code: Language code (e.g., 'HIN', 'BEN')
        language_name: English name of the language
        native_name: Native name of the language
        script_name: Name of the script used
        reference_text: Optional reference text for the audio
    
    Returns:
        Complete prompt string
    """
    
    # Special handling for Hinglish
    if language_code == "HINGLISH":
        script_rules = """
    CRITICAL SCRIPT SEPARATION RULE - THIS IS THE MOST IMPORTANT REQUIREMENT:
    
    ABSOLUTE RULE FOR SCRIPT USAGE:
    - If a word is ENGLISH origin → Write in LATIN/ROMAN script ONLY (a-z, A-Z)
    - If a word is HINDI origin → Write in DEVANAGARI script ONLY (अ-ज्ञ)
    - NO EXCEPTIONS. NO TRANSLITERATION. NO MIXING.
    
    FORBIDDEN ACTIONS:
    - NEVER write English words in Devanagari (e.g., "टेस्ट" - MUST write "test")
    - NEVER write "स्टूडेंट" - MUST write "student"
    - NEVER write technical terms in Devanagari - use Latin script
    
    CORRECT EXAMPLES:
    ✓ "मैं test दे रहा हूँ" (NOT "मैं टेस्ट दे रहा हूँ")
    ✓ "student की capability" (NOT "स्टूडेंट की कैपेबिलिटी")
    ✓ "यह system अच्छा है" (NOT "यह सिस्टम अच्छा है")
    
    HOW TO IDENTIFY WORD ORIGIN:
    - English words: test, student, system, paper, question, marks, etc. → Latin script
    - Hindi words: मैं, यार, था, नहीं, लगता, आज, कल, etc. → Devanagari script
    """
    else:
        script_rules = f"""
    CRITICAL SCRIPT RULES FOR {language_name.upper()}:
    
    MANDATORY SCRIPT USAGE:
    1. {language_name} words → {script_name} ONLY
       - Use proper orthography and spelling for {language_name}
       - Include all necessary diacritical marks
    
    2. PROPER NOUNS and BORROWED WORDS:
       - Native proper nouns: Write in {script_name}
       - Foreign proper nouns (names, brands, places): Wrap in <proper-noun></proper-noun> tags
       - Example: "मेरा नाम <proper-noun>Rahul</proper-noun> है"
       - Example for technical terms: "<proper-noun>ChatGPT</proper-noun> बहुत अच्छा है"
    
    3. ENGLISH/FOREIGN WORDS IN SPEECH:
       - If speaker uses English words naturally: wrap in <proper-noun></proper-noun> tags
       - Keep pronunciation-based transliteration ONLY if it's how they actually spoke
    
    CORRECT EXAMPLES for {language_name}:
    - Write all {language_name} content in {script_name}
    - Wrap English/foreign words: "<proper-noun>English-word</proper-noun>"
    - Preserve natural speech patterns
    """
    
    # Reference text section
    reference_section = ""
    if reference_text:
        reference_section = f"""
    ============================================================================
    REFERENCE TEXT PROVIDED (Use for guidance on content and accuracy)
    ============================================================================
    
    {reference_text}
    
    NOTE: This reference text shows the expected content. Use it to:
    - Improve transcription accuracy
    - Understand context better
    - Verify proper nouns and technical terms
    - Ensure correct spelling of specific terms
    
    However, you must still:
    - Transcribe what you actually hear in the audio
    - Follow the script separation rules strictly
    - Detect actual speaker changes and emotions from audio
    - Provide accurate timestamps based on the audio
    ============================================================================
    """
    
    prompt = f"""
    ============================================================================
    {language_name.upper()} AUDIO TRANSCRIPTION - INSTRUCTIONS
    ============================================================================
    
    Listen to this {language_name} audio file with multiple speakers and produce an accurate 
    PHRASE/SENTENCE-LEVEL transcription with timestamps, SPEAKER IDENTIFICATION, and EMOTION DETECTION.
    
    OBJECTIVE: 
    Generate precise {language_name} phrase-level transcriptions with:
    - Accurate timestamps for each speech segment (phrase or sentence)
    - Speaker identification (Speaker A, Speaker B, Speaker C, etc.)
    - Language tagging: "{language_code}"
    - Emotion detection for each segment
    - End-of-speech detection
    
    ============================================================================
    {script_rules}
    ============================================================================
    {reference_section}
    
    SPEAKER DIARIZATION RULES:
    - Identify and label each distinct speaker as "Speaker A", "Speaker B", "Speaker C", etc.
    - Maintain consistency: the same voice should always get the same speaker label
    - Speaker changes should create new entries
    - If uncertain about a speaker, make your best estimate and stay consistent
    
    EMOTION DETECTION RULES (CRITICAL - DO NOT DEFAULT TO NEUTRAL):
    Analyze the speaker's VOCAL TONE, PITCH, SPEED, and ENERGY to detect emotions accurately.
    
    Available emotions and their vocal indicators:
    
    1. "happy" - Upbeat tone, higher pitch, laughter, enthusiasm
    2. "angry" - Loud, forceful, sharp tone, raised volume
    3. "calm" - Relaxed, steady pace, smooth tone, measured delivery
    4. "polite" - Gentle, courteous, formal manner, soft voice
    5. "excited" - High energy, animated, fast-paced, rising intonation
    6. "sad" - Lower pitch, slower pace, subdued voice, hesitation
    7. "neutral" - Strictly factual, no emotional coloring (USE SPARINGLY)
    8. "frustrated" - Annoyed, tense, exasperation, wavering voice
    9. "persuasive" - Confident, deliberate, emphasizing key words
    10. "sarcastic" - Mocking, exaggerated, ironic tone
    11. "empathetic" - Warm, caring, compassionate, gentle
    12. "confident" - Assertive, authoritative, strong voice
    13. "nervous" - Trembling tone, anxious, stammering, filler words
    14. "surprised" - Sudden pitch rise, gasp, unexpected tone
    15. "disgusted" - Harsh, nasal, rejection sounds
    16. "worried" - Concerned tone, anxious, expressing concern
    17. "enthusiastic" - Very eager, passionate, energetic
    18. "disappointed" - Expectations not met, let-down tone
    19. "amused" - Finding something funny, light-hearted
    20. "curious" - Interested, questioning tone
    
    EMOTION DETECTION STRATEGY:
    - Listen to HOW they say it, not just WHAT they say
    - Pay attention to voice modulation, tone changes, and energy
    - In conversations, people naturally show emotions - detect them!
    - Default to "neutral" ONLY if absolutely no emotion is detectable
    - Aim for diverse emotions across the conversation
    
    MANDATORY REQUIREMENTS:
    
    1. Timestamp Format:
       - Use format HH:MM:SS:mmm (hours:minutes:seconds:milliseconds)
       - Example: "00:00:03:450" means 3 seconds and 450 milliseconds
       - Milliseconds must be 3 digits (pad with zeros: 050, 100, 000)
       - Ensure start < end for every entry
       - Keep entries in chronological order
    
    2. Speech Segmentation:
       - One entry per speech segment (phrase or sentence)
       - Natural pause or speaker change creates new entry
       - Keep related thoughts together in one segment
       - Don't make segments too long (max ~30 seconds)
    
    3. End of Speech Detection:
       - Set "end_of_speech": true for the LAST segment in the audio
       - Set "end_of_speech": false for all other segments
    
    4. Language Tagging:
       - Use "{language_code}" for {language_name} language segments
    
    OUTPUT FORMAT (STRICT JSON SCHEMA):
    ```json
    [
        {{
            "start": "HH:MM:SS:mmm",
            "end": "HH:MM:SS:mmm",
            "speaker": "Speaker A",
            "text": "complete phrase in proper script",
            "emotion": "detected_emotion",
            "language": "{language_code}",
            "end_of_speech": false
        }}
    ]
    ```
    
    EXAMPLE OUTPUT:
    [
        {{
            "start": "00:00:05:000",
            "end": "00:00:10:500",
            "speaker": "Speaker A",
            "text": "{language_name} text in {script_name}",
            "emotion": "happy",
            "language": "{language_code}",
            "end_of_speech": false
        }},
        {{
            "start": "00:00:12:200",
            "end": "00:00:18:750",
            "speaker": "Speaker B",
            "text": "{language_name} text in {script_name}",
            "emotion": "calm",
            "language": "{language_code}",
            "end_of_speech": true
        }}
    ]
    
    CRITICAL OUTPUT REQUIREMENTS:
    - Return ONLY the JSON array wrapped in ```json ``` code block
    - Include ALL seven fields for every entry
    - Ensure valid JSON syntax
    - Arrange entries chronologically
    - Use "Speaker A", "Speaker B" format
    - Set end_of_speech to true ONLY for the last segment
    - NO explanatory text before or after the JSON
    - NO comments within the JSON
    
    EMOTION DETECTION IS MANDATORY:
    - DO NOT use "neutral" for all segments
    - ACTIVELY listen for vocal cues, tone, pitch, and energy
    - Natural conversations have VARIED emotions
    - Aim for emotional diversity across segments
    
    ============================================================================
    NOW: Process the audio and return ONLY the pure JSON array
    ============================================================================
    """
    
    return prompt


def transcribe_chunk(idx: int, chunk_path: str, language_code: str, 
                     language_name: str, native_name: str, script_name: str,
                     reference_text: Optional[str] = None) -> tuple:
    """
    Transcribe a single audio chunk for any language with speaker identification.
    
    Args:
        idx: Chunk index
        chunk_path: Path to audio chunk file
        language_code: Language code (e.g., 'HIN', 'BEN')
        language_name: English name of language
        native_name: Native name of language
        script_name: Name of script
        reference_text: Optional reference text
    
    Returns:
        Tuple of (index, transcription_data)
    """
    model = GenerativeModel(MODEL_NAME)
    
    prompt = build_transcription_prompt(
        language_code, language_name, native_name, script_name, reference_text
    )
    
    with open(chunk_path, "rb") as af:
        audio_file = Part.from_data(af.read(), mime_type="audio/mpeg")
    
    safety_settings = [
        SafetySetting(category="HARM_CATEGORY_HATE_SPEECH", threshold="BLOCK_NONE"),
        SafetySetting(category="HARM_CATEGORY_HARASSMENT", threshold="BLOCK_NONE"),
        SafetySetting(category="HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold="BLOCK_NONE"),
        SafetySetting(category="HARM_CATEGORY_DANGEROUS_CONTENT", threshold="BLOCK_NONE"),
    ]
    
    def call_model():
        config = GenerationConfig(
            audio_timestamp=True,
            max_output_tokens=8192,
            temperature=0.05  # Very low temperature for strict instruction following
        )
        return model.generate_content(
            [audio_file, prompt],
            generation_config=config,
            safety_settings=safety_settings
        )
    
    print(f"🎤 Processing chunk {idx}...")
    response = retry_with_backoff(call_model)
    
    # Check finish reason
    finish_reason = response.candidates[0].finish_reason
    if finish_reason != 1:
        print(f"⚠️ Warning: Response may be incomplete. Finish reason: {finish_reason}")
    
    content = response.candidates[0].content.text
    json_data = safe_extract_json(content)
    
    print(f"✅ Chunk {idx} completed: {len(json_data)} segments transcribed")
    return idx, json_data


def transcribe_chunks(audio_path: str, duration: float, language_code: str,
                     language_name: str, native_name: str, script_name: str,
                     reference_text: Optional[str] = None) -> List[Dict]:
    """
    Transcribe audio by splitting into chunks and processing in parallel.
    
    Args:
        audio_path: Path to audio file
        duration: Audio duration in seconds
        language_code: Language code
        language_name: English name of language
        native_name: Native name of language
        script_name: Name of script
        reference_text: Optional reference text
    
    Returns:
        Combined transcription data
    """
    chunks_dict = split_audio(audio_path)
    results = {}
    
    # Process chunks (can increase max_workers for faster processing)
    with ThreadPoolExecutor(max_workers=1) as executor:
        future_to_idx = {
            executor.submit(
                transcribe_chunk, idx, chunk_path, language_code,
                language_name, native_name, script_name, reference_text
            ): idx
            for idx, chunk_path in chunks_dict.items()
        }
        
        for future in as_completed(future_to_idx):
            idx = future_to_idx[future]
            try:
                idx, json_data = future.result()
                results[idx] = json_data
            except Exception as e:
                print(f"❌ Error processing chunk {idx}: {str(e)}")
                raise
    
    # Merge chunks with time offset
    final_json = merge_json_with_offset(results, AUDIO_CHUNKING_OFFSET)
    return final_json


def transcribe_audio(audio_path: str, output_json: str, 
                    source_language: str = "HIN",
                    reference_text: Optional[str] = None) -> List[Dict]:
    """
    Main function to transcribe audio in any supported language with multiple speakers.
    
    Args:
        audio_path: Path to the input audio file (mp3, wav, etc.)
        output_json: Path to save the output JSON file
        source_language: Source language code (e.g., 'HIN', 'BEN', 'HINGLISH')
        reference_text: Optional reference text for the audio content
    
    Returns:
        List containing transcription results
    """
    # Get language configuration
    lang_code, lang_name, native_name, script_name = get_language_config(source_language)
    
    print(f"\n{'='*100}")
    print(f"🎯 Multilingual Audio Transcription")
    print(f"{'='*100}")
    print(f"📁 Audio File: {audio_path}")
    print(f"🌐 Language: {lang_name} ({native_name}) - Code: {lang_code}")
    print(f"📜 Script: {script_name}")
    print(f"💾 Output: {output_json}")
    print(f"🤖 Model: {MODEL_NAME}")
    if reference_text:
        print(f"📝 Reference Text: Provided ({len(reference_text)} characters)")
    print(f"{'='*100}\n")
    
    # Validate audio file exists
    if not os.path.exists(audio_path):
        raise FileNotFoundError(f"Audio file not found: {audio_path}")
    
    # Get audio duration
    print("📊 Analyzing audio file...")
    audio = AudioSegment.from_file(audio_path)
    audio_duration = len(audio) / 1000.0  # Convert to seconds
    print(f"⏱️  Audio Duration: {audio_duration:.2f} seconds ({audio_duration/60:.2f} minutes)")
    
    # Transcribe
    start_time = time.time()
    
    if audio_duration <= AUDIO_CHUNKING_OFFSET:
        print(f"🎤 Processing single audio file...")
        idx, transcription_data = transcribe_chunk(
            0, audio_path, lang_code, lang_name, native_name, 
            script_name, reference_text
        )
    else:
        print(f"🎤 Audio is long. Splitting into {int(audio_duration / AUDIO_CHUNKING_OFFSET) + 1} chunks...")
        transcription_data = transcribe_chunks(
            audio_path, audio_duration, lang_code, lang_name, 
            native_name, script_name, reference_text
        )
    
    # Organize output
    speakers = set(item.get('speaker', 'Unknown') for item in transcription_data)
    
    # Output the transcription array as the main result
    output_data = transcription_data
    
    # Save JSON output
    ensure_dir(os.path.dirname(output_json))
    save_json(output_data, output_json)
    
    # Print summary
    elapsed_time = time.time() - start_time
    print(f"\n{'='*100}")
    print(f"✅ TRANSCRIPTION COMPLETED!")
    print(f"{'='*100}")
    print(f"⏱️  Processing Time: {elapsed_time:.2f} seconds")
    print(f"📊 Total Segments: {len(transcription_data)}")
    print(f"👥 Total Speakers: {len(speakers)}")
    print(f"🎭 Speakers: {', '.join(sorted(speakers))}")
    print(f"💾 Output saved to: {output_json}")
    print(f"{'='*100}\n")
    
    # Print sample transcription
    print("📝 Sample Transcription (first 5 segments):")
    print(f"{'='*100}")
    for i, segment in enumerate(transcription_data[:5]):
        text = segment.get('text', '')
        
        print(f"\n[{i+1}] {segment['start']} → {segment['end']}")
        print(f"    Speaker: {segment.get('speaker', 'Unknown')} | Emotion: {segment.get('emotion', 'neutral')} | Language: {segment.get('language', 'Unknown')}")
        print(f"    Text: {text}")
    print(f"\n{'='*100}\n")
    
    return output_data


def analyze_transcription(json_path: str):
    """
    Analyze and display statistics from a transcription JSON file.
    
    Args:
        json_path: Path to the transcription JSON file
    """
    with open(json_path, 'r', encoding='utf-8') as f:
        transcription = json.load(f)
    
    # Emotion statistics
    emotion_stats = {}
    for segment in transcription:
        emotion = segment.get('emotion', 'neutral')
        emotion_stats[emotion] = emotion_stats.get(emotion, 0) + 1
    
    # Speaker statistics
    speaker_stats = {}
    for segment in transcription:
        speaker = segment.get('speaker', 'Unknown')
        if speaker not in speaker_stats:
            speaker_stats[speaker] = {
                'count': 0,
                'emotions': {}
            }
        speaker_stats[speaker]['count'] += 1
        
        emotion = segment.get('emotion', 'neutral')
        speaker_stats[speaker]['emotions'][emotion] = speaker_stats[speaker]['emotions'].get(emotion, 0) + 1
    
    print(f"\n{'='*100}")
    print(f"📊 TRANSCRIPTION ANALYSIS")
    print(f"{'='*100}")
    print(f"📝 Total Segments: {len(transcription)}")
    
    print(f"\n😊 Emotion Distribution:")
    for emotion, count in sorted(emotion_stats.items(), key=lambda x: x[1], reverse=True):
        print(f"   {emotion.capitalize()}: {count} segments ({count/len(transcription)*100:.1f}%)")
    
    print(f"\n👥 Speaker Statistics:")
    for speaker, stats in sorted(speaker_stats.items()):
        print(f"\n   {speaker}:")
        print(f"      Total segments: {stats['count']}")
        print(f"      Top Emotions: {', '.join([f'{e}: {c}' for e, c in sorted(stats['emotions'].items(), key=lambda x: x[1], reverse=True)[:3]])}")
    
    print(f"{'='*100}\n")


def list_supported_languages():
    """Print list of all supported languages."""
    print("\n" + "="*100)
    print("🌐 SUPPORTED LANGUAGES")
    print("="*100)
    print(f"{'Code':<15} {'English Name':<20} {'Native Name':<30} {'Script':<25}")
    print("-"*100)
    for lang in SupportedLanguage:
        print(f"{lang.code:<15} {lang.english_name:<20} {lang.native_name:<30} {lang.script:<25}")
    print("="*100 + "\n")


if __name__ == "__main__":
    import sys
    
    if len(sys.argv) < 2:
        print("Usage: python multilingual_transcription.py <audio_file> <language> [options]")
        print("\nRequired Arguments:")
        print("  <audio_file>       Path to audio file")
        print("  <language>         Language name or code (e.g., Hindi, BEN, Hinglish)")
        print("\nOptional Arguments:")
        print("  --output, -o       Output JSON file path")
        print("  --reference, -r    Reference text file path (optional)")
        print("  --list-languages   Show all supported languages")
        print("\nExamples:")
        print("  python multilingual_transcription.py audio.mp3 Hindi")
        print("  python multilingual_transcription.py audio.mp3 Bengali")
        print("  python multilingual_transcription.py audio.mp3 Hinglish -o output.json")
        print("  python multilingual_transcription.py audio.mp3 Tamil -r reference.txt")
        print("  python multilingual_transcription.py audio.mp3 HIN  # Using language code")
        print("  python multilingual_transcription.py --list-languages")
        print("\nSupported audio formats: mp3, wav, m4a, ogg, flac")
        sys.exit(1)
    
    # Check if user wants to list languages
    if "--list-languages" in sys.argv or sys.argv[1] == "--list-languages":
        list_supported_languages()
        sys.exit(0)
    
    # Get required arguments
    audio_file = sys.argv[1]
    
    # Get language (positional argument or default)
    if len(sys.argv) >= 3 and not sys.argv[2].startswith('-'):
        source_language = sys.argv[2]
        start_index = 3
    else:
        # Default to Hindi if not specified
        print("⚠️  Warning: No language specified, defaulting to Hindi")
        source_language = "HIN"
        start_index = 2
    
    # Parse optional arguments
    output_file = None
    reference_text_path = None
    
    i = start_index
    while i < len(sys.argv):
        arg = sys.argv[i]
        if arg in ["--output", "-o"] and i + 1 < len(sys.argv):
            output_file = sys.argv[i + 1]
            i += 2
        elif arg in ["--reference", "-r"] and i + 1 < len(sys.argv):
            reference_text_path = sys.argv[i + 1]
            i += 2
        else:
            i += 1
    
    # Auto-generate output filename if not provided
    if output_file is None:
        output_dir = "transcriptions"
        ensure_dir(output_dir)
        output_file = os.path.join(
            output_dir,
            f"{Path(audio_file).stem}_{source_language.lower()}_transcription.json"
        )
    
    # Load reference text if provided
    reference_text = None
    if reference_text_path:
        if os.path.exists(reference_text_path):
            with open(reference_text_path, 'r', encoding='utf-8') as f:
                reference_text = f.read().strip()
            print(f"✅ Loaded reference text from: {reference_text_path}")
        else:
            print(f"⚠️ Warning: Reference text file not found: {reference_text_path}")
    
    try:
        # Transcribe
        result = transcribe_audio(
            audio_path=audio_file,
            output_json=output_file,
            source_language=source_language,
            reference_text=reference_text
        )
        
        # Analyze
        analyze_transcription(output_file)
        
        print("✅ All done! Check the output file for complete transcription.\n")
        
    except Exception as e:
        print(f"\n❌ ERROR: {str(e)}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


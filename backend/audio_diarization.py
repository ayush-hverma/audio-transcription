"""
Module for audio diarization and transcription using Gemini 2.0.
"""
import os
import sys
import json
import time
from pathlib import Path
import re
import random
import hashlib

# Add parent directory to path to import from utils and pipeline
sys.path.insert(0, str(Path(__file__).parent.parent))

from vertexai.generative_models import GenerativeModel, Part, GenerationConfig
from vertexai.preview.generative_models import SafetySetting

from pydub import AudioSegment

from utils.file_utils import ensure_dir, clear_gpu_memory, save_json
from utils.audio_utils import extract_audio_clips
from utils.audio_splitter import split_audio

from concurrent.futures import ThreadPoolExecutor, as_completed

from pipeline.pipeline_config import GOOGLE_APPLICATION_CREDENTIALS, LANGUAGE_CODES
# Set Google credentials for authentication
os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = GOOGLE_APPLICATION_CREDENTIALS
AUDIO_CHUNKING_OFFSET = 300


def find_script(source_lang):
    language_script_map = LANGUAGE_CODES
    return language_script_map.get(source_lang, "Latin")

def safe_extract_content(content):
    json_match = re.search(r'```json\s*(.*?)```', content, re.DOTALL)
    if not json_match:
        raise ValueError("No JSON block found in content.")
    json_str = json_match.group(1).strip()
    if not (json_str.startswith('[') and json_str.endswith(']')):
        json_str = f"[{json_str}]"
    json_str = re.sub(r',\s*([\]}])', r'\1', json_str)
    json_data = json.loads(json_str)
    
    return json_data[0]

def deduplicate_entries(items):
    """Remove duplicate entries with the same timestamps."""
    seen = set()
    deduplicated = []
    
    for item in items:
        # Create a key based on start and end time
        key = (item.get('start'), item.get('end'))
        
        if key not in seen:
            seen.add(key)
            deduplicated.append(item)
        else:
            # If we've seen this timestamp, only keep if it has different content
            existing = next((x for x in deduplicated if x['start'] == item['start'] and x['end'] == item['end']), None)
            if existing and existing.get('word') != item.get('word'):
                # Merge the words if they're different
                existing['word'] = f"{existing['word']} {item['word']}"
    
    return deduplicated

def safe_extract_json(content):
    # Try to find JSON block with closing backticks first
    json_match = re.search(r'```json\s*(.*?)```', content, re.DOTALL)
    
    # If not found, try to extract JSON without closing backticks (truncated response)
    if not json_match:
        json_match = re.search(r'```json\s*(.*)', content, re.DOTALL)
        if not json_match:
            print("❌ ERROR: No JSON block found in content.")
            print(f"Content preview: {content[:500]}...")
            raise ValueError("No JSON block found in content.")
    
    json_str = json_match.group(1).strip()
    
    # Fix common JSON syntax errors
    # Fix missing quotes before commas (e.g., "00:43.719, -> "00:43.719",)
    json_str = re.sub(r'(\d+\.\d+),(\s*\n)', r'\1",\2', json_str)
    json_str = re.sub(r'(\d+\.\d+)(\s*\n\s*"end")', r'\1"\2', json_str)
    
    # Remove any invalid control characters
    json_str = ''.join(char for char in json_str if ord(char) >= 32 or char in '\n\r\t')
    
    # Try to find the end of a valid JSON array if it's incomplete
    # Find the last complete JSON object
    if not json_str.endswith(']'):
        # Find the last complete object by looking for the last }
        last_complete = json_str.rfind('}')
        if last_complete != -1:
            json_str = json_str[:last_complete + 1]
            # Add closing bracket if missing
            if not json_str.endswith(']'):
                json_str += '\n]'
    
    # Ensure proper JSON array format
    if not (json_str.startswith('[') and json_str.endswith(']')):
        json_str = f"[{json_str}]"
    
    # Remove trailing commas before closing brackets
    json_str = re.sub(r',\s*([\]}])', r'\1', json_str)
    
    try:
        json_data = json.loads(json_str)
    except json.JSONDecodeError as e:
        print(f"❌ JSON parsing error: {e}")
        print(f"JSON string preview (first 500 chars): {json_str[:500]}...")
        print(f"JSON string preview (around error): {json_str[max(0, e.pos-100):min(len(json_str), e.pos+100)]}")
        
        # Try one more aggressive fix: find and fix all timestamp patterns
        print("⚠️ Attempting aggressive JSON repair...")
        # Fix any timestamp without closing quote: "start": "MM:SS.mmm[,\n]
        json_str = re.sub(r'"(start|end)":\s*"(\d+:\d+\.\d+)([,\n])', r'"\1": "\2"\3', json_str)
        
        try:
            json_data = json.loads(json_str)
            print("✓ Aggressive repair successful!")
        except json.JSONDecodeError as e2:
            print(f"❌ Aggressive repair failed: {e2}")
            raise ValueError(f"Failed to parse JSON after repair attempts: {e}")
    
    # Validate and clean the data
    valid_items = []
    for item in json_data:
        if not all(k in item for k in ["start", "end"]):
            print(f"⚠️ Warning: Skipping invalid caption object (missing start/end): {item}")
            continue
        
        # Support both old format (text/Text) and new format (word)
        if "word" not in item and ("Text" in item or "text" in item):
            item["word"] = item.get("Text") or item.get("text")
        elif "word" not in item:
            print(f"⚠️ Warning: Skipping item without 'word' field: {item}")
            continue
        
        valid_items.append(item)
    
    if not valid_items:
        raise ValueError("No valid items found in JSON data")
    
    # Deduplicate entries with the same timestamps
    valid_items = deduplicate_entries(valid_items)
    
    return valid_items

def retry_with_backoff(func, max_retries=5, base_delay=15.0, max_delay=300.0, *args, **kwargs):
    for attempt in range(max_retries):
        try:
            return func(*args, **kwargs)
        except Exception as e:
            if attempt == max_retries - 1:
                raise
            delay = min(max_delay, base_delay * (2 ** attempt))
            jitter = random.uniform(0, delay * 0.1)
            total_delay = delay + jitter
            time.sleep(total_delay)

def timestamp_to_seconds(timestamp: str) -> float:
    """Convert a timestamp string like 'MM:SS.mmm' to seconds."""
    minutes, rest = timestamp.split(":")
    seconds = float(rest)
    return int(minutes) * 60 + seconds

def seconds_to_timestamp(seconds: float) -> str:
    """Convert seconds to timestamp string like 'MM:SS.mmm'."""
    minutes = int(seconds // 60)
    secs = seconds % 60
    return f"{minutes:02d}:{secs:06.3f}"

def merge_json_with_offset(data, time_offset):
    """
    Merge multiple JSON arrays from a dict and apply offset * i seconds to each i-th array.
    
    Args:
        data: Dictionary where keys are indices and values are JSON arrays.
        time_offset: Time in seconds to shift for each index.
    
    Returns:
        Merged and shifted JSON array.
    """
    merged_array = []

    # Sort dictionary by index before processing
    sorted_data = sorted(data.items(), key=lambda x: x[0])

    for i, json_array in sorted_data:
        offset_seconds = i * time_offset
        for entry in json_array:
            new_entry = entry.copy()
            new_entry['start'] = seconds_to_timestamp(timestamp_to_seconds(entry['start']) + offset_seconds)
            new_entry['end'] = seconds_to_timestamp(timestamp_to_seconds(entry['end']) + offset_seconds)
            merged_array.append(new_entry)

    return merged_array

def transcribe_chunk(idx, chunk_path, source_lang, source_script, target_lang, reference_passage=None):
    model = GenerativeModel("gemini-2.0-flash")
    
    # Build reference passage section if provided
    reference_section = ""
    if reference_passage:
        reference_section = f"""
    📝 REFERENCE PASSAGE PROVIDED:
    The following is the reference text that may correspond to the audio content.
    Use this ONLY as a guide for spelling, vocabulary, and context.
    
    "{reference_passage}"
    
    ⚠️ CRITICAL: You MUST transcribe the ACTUAL SPOKEN WORDS from the audio.
    - If the speaker deviates from the reference text, transcribe what is ACTUALLY SAID
    - If the speaker skips words, DO NOT include them
    - If the speaker adds extra words, INCLUDE them
    - If the speaker mispronounces or says something differently, transcribe the ACTUAL pronunciation
    - The reference is for context only - ALWAYS prioritize what you hear in the audio
    
    """
    
    prompt = f"""
    Listen to the {source_lang} audio file and produce an accurate, WORD-LEVEL transcription with precise timestamps.
    
    🎯 OBJECTIVE: 
    Generate precise {source_lang} word-level transcriptions in {source_script} script with accurate timestamps.
    This is a professional transcription task requiring extremely high accuracy.
    
    {reference_section}
    🏷️ SPECIAL TAGS SUMMARY:
    - <FIL></FIL> = Vocalized fillers like 'અમ' (NOT for single 'અ')
    - <NOISE></NOISE> = Unintelligible/noisy audio (can wrap words: <NOISE>"word"</NOISE>)
    - <NPS></NPS> = Non-primary speaker segments
    - <AI></AI> = Accent-inclusive variations (e.g., <AI>છ</AI> for regional 'છે')
    
    ⚙️ MANDATORY ANNOTATION RULES (NO EXCEPTIONS):
    
    1. Language & Script Requirements:
       ✓ MUST transcribe in {source_script} script ONLY
       ✓ MUST write EXACTLY what is spoken - no corrections, no normalization
       ✓ MUST preserve dialectal variations, colloquialisms, and regional pronunciations
       ✗ DO NOT transliterate to any other script
       ✗ DO NOT correct grammar or pronunciation
       ✗ DO NOT standardize informal speech
       ✗ DO NOT translate or interpret
    
    2. Timestamp Precision (STRICTLY ENFORCED):
       ✓ MUST provide start and end time for EVERY SINGLE SPOKEN WORD
       ✓ MUST use format MM:SS.mmm (exactly 3 decimal places, no more, no less)
       ✓ MUST align timestamps tightly with actual speech boundaries
       ✓ MUST ensure end time ≤ audio file duration
       ✓ MUST ensure start time < end time for every entry
       ✓ MUST order entries chronologically by start time
       ✗ DO NOT approximate - be precise to milliseconds
       ✗ DO NOT overlap timestamps between consecutive words
       ✗ DO NOT leave gaps longer than natural speech pauses
    
    3. Word Segmentation Rules:
       ✓ MUST create one entry per spoken word unit
       ✓ MUST split compound words if there's a pause >25ms between components
       ✓ MUST treat contractions as single units unless clearly separated
       ✗ DO NOT merge multiple words into one entry
       ✗ DO NOT split continuously spoken syllables
    
    4. Special Tags & Cases (Apply When Necessary):
       
       a) Fillers and Pauses:
          ✓ Vocalized fillers like 'અમ' → Use <FIL></FIL> tag
          ✓ Single 'અ' sound → Transcribe directly as 'અ' (no FIL tag)
          ✓ Only mark fillers lasting >100ms
          ✗ DO NOT tag every brief hesitation
          
       b) Mumbling and Noise:
          ✓ Unintelligible or noisy audio → Use <NOISE></NOISE>
          ✓ Background noise WITH audible word → Use <NOISE>"WORD"</NOISE>
          ✓ Only background noise (no speech) → Use <NOISE></NOISE> with timestamp
          ✓ Can be used for unwanted background sounds heard along with orator
          ✗ DO NOT use for clear speech, even if audio quality is low
          
       c) Multiple Speakers:
          ✓ Non-primary speaker audio → Use <NPS></NPS> tag
          ✓ MUST timestamp these segments accurately (for audio removal)
          ✓ Important: These segments may need to be removed to avoid model confusion
          ✗ DO NOT tag feeble non-primary sounds that don't distort primary speaker
          ✗ DO NOT use if secondary speaker is barely audible
          
       d) Accent Inclusive Transcription:
          ✓ Regional/local accent variations → Use <AI></AI> tag
          ✓ MUST transcribe EXACTLY as pronounced, not standard form
          ✓ Examples:
             - 'છે' pronounced as 'છ' → Transcribe as <AI>'છ'</AI>
             - 'છે' pronounced as 'સ' → Transcribe as <AI>'સ'</AI>
             - 'લાવ્યોતો' pronounced as 'લાયોતો' → Transcribe as <AI>'લાયોતો'</AI>
          ✓ Captures phoneme omissions, regional sound variations
          ✗ DO NOT correct to standard pronunciation
          ✗ DO NOT normalize dialectal variations
    
    5. Data Quality Requirements:
       ✓ MUST avoid duplicate timestamps (same start AND end)
       ✓ MUST skip silence periods - only transcribe actual speech
       ✓ MUST validate each entry has all required fields
       ✗ DO NOT include null, empty, or invalid entries
       ✗ DO NOT approximate when unsure - re-listen carefully
    
    📋 OUTPUT FORMAT (STRICT JSON SCHEMA):
    ```json
    [
    {{
    "start": "MM:SS.mmm",
    "end": "MM:SS.mmm",
    "word": "word in {source_script} script",
    "language": "{source_lang}"
    }}
    ]
    ```
    
    📌 EXAMPLES OF TAGGED OUTPUT:
    - Filler: {{"start": "00:05.120", "end": "00:05.450", "word": "<FIL></FIL>", "language": "{source_lang}"}}
    - Single 'અ': {{"start": "00:05.120", "end": "00:05.200", "word": "અ", "language": "{source_lang}"}}
    - Noise only: {{"start": "00:10.500", "end": "00:11.200", "word": "<NOISE></NOISE>", "language": "{source_lang}"}}
    - Word with noise: {{"start": "00:15.300", "end": "00:15.800", "word": "<NOISE>\"શબ્દ\"</NOISE>", "language": "{source_lang}"}}
    - Non-primary speech: {{"start": "00:20.100", "end": "00:22.500", "word": "<NPS></NPS>", "language": "{source_lang}"}}
    - Accent inclusive: {{"start": "00:25.000", "end": "00:25.400", "word": "<AI>છ</AI>", "language": "{source_lang}"}}
    
    🚨 CRITICAL OUTPUT REQUIREMENTS:
    ✓ MUST return ONLY the JSON array wrapped in ```json ``` code block
    ✓ MUST include all four fields (start, end, word, language) for every entry
    ✓ MUST ensure valid JSON syntax (proper quotes, commas, brackets)
    ✓ MUST limit each timestamp to exactly 3 decimal places
    ✓ MUST arrange entries in chronological order
    
    ✗ ABSOLUTELY NO explanatory text before or after the JSON
    ✗ ABSOLUTELY NO comments within the JSON
    ✗ ABSOLUTELY NO markdown formatting except the ```json wrapper
    ✗ ABSOLUTELY NO incomplete entries
    ✗ ABSOLUTELY NO duplicate timestamps
    ✗ ABSOLUTELY NO timestamps exceeding audio duration
    
    ⚡ FINAL VALIDATION CHECKLIST:
    Before returning, verify:
    [ ] Every spoken word has an entry
    [ ] All timestamps are in MM:SS.mmm format with 3 decimals
    [ ] All entries are in chronological order
    [ ] No duplicate timestamps exist
    [ ] No overlapping time ranges exist
    [ ] All words are in {source_script} script (unless tagged)
    [ ] Special tags used appropriately:
        - <FIL></FIL> only for 'અમ' and similar fillers
        - Single 'અ' transcribed without FIL tag
        - <NOISE></NOISE> for unintelligible/noisy segments
        - <NPS></NPS> for non-primary speakers (accurately timestamped)
        - <AI></AI> for accent variations (transcribed as-is)
    [ ] Last end time ≤ audio duration
    [ ] JSON is valid and parseable
    [ ] No explanatory text included
    
    NOW: Process the audio and return ONLY the pure JSON array.
    """

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
            max_output_tokens=8192,  # Increase token limit
            temperature=0.1  # Lower temperature for more consistent output
        )
        return model.generate_content([audio_file, prompt], generation_config=config, safety_settings=safety_settings)

    response = retry_with_backoff(call_model)
    
    # Check if response was truncated
    finish_reason = response.candidates[0].finish_reason
    if finish_reason != 1:  # 1 means STOP (normal completion)
        print(f"⚠️ Warning: Response may be incomplete. Finish reason: {finish_reason}")
    
    content = response.candidates[0].content.text
    print(content)
    json_data = safe_extract_json(content)
    return idx, json_data

def transcribe_chunks(audio_uri, source_lang, source_script, target_lang, duration, reference_passage=None):
    chunks_dict = split_audio(audio_uri)
    results = {}

    with ThreadPoolExecutor(max_workers=1) as executor:
        future_to_idx = {
            executor.submit(transcribe_chunk, idx, chunk_uri, source_lang, source_script, target_lang, reference_passage): idx
            for idx, chunk_uri in chunks_dict.items()
        }

        for future in as_completed(future_to_idx):
            idx = future_to_idx[future]
            idx, json_data = future.result()
            results[idx] = json_data

    final_json = merge_json_with_offset(results, AUDIO_CHUNKING_OFFSET)
    return final_json

def transcribe_with_gemini(audio_path, source_lang, target_lang, duration, reference_passage=None):
    source_script = find_script(source_lang)
    print("Duration   :  ", duration, AUDIO_CHUNKING_OFFSET)
    if duration <= AUDIO_CHUNKING_OFFSET:
        idx, transcription = transcribe_chunk(0, audio_path, source_lang, source_script, target_lang, reference_passage)
        return transcription
    else:
        print(f"audio path in transcribe_with_gemini is is {audio_path}")
        transcription = transcribe_chunks(audio_path, source_lang, source_script, target_lang, duration, reference_passage)
        return transcription

def get_segments(audio_path, source_lang, target_lang, reference_passage=None):
    all_segments = []
    
    # Get the audio file length in seconds using pydub
    audio = AudioSegment.from_file(audio_path)
    audio_length = len(audio) / 1000.0

    all_segments = transcribe_with_gemini(audio_path, source_lang, target_lang, audio_length, reference_passage)

    return all_segments

def format_timestamp_precise(seconds):
    """Format seconds to H:MM:SS.mmmmmm with exactly 6 decimal places."""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = seconds % 60
    return f"{hours}:{minutes:02d}:{secs:09.6f}"

def process_diarization(audio_path, output_json, source_lang, target_lang, reference_passage=None):
    """
    Process audio file for word-level transcription with precise timestamps.
    
    Args:
        audio_path: Path to the audio file
        output_json: Path to save the output JSON
        source_lang: Source language (e.g., "Gujarati")
        target_lang: Target language (e.g., "English")
        reference_passage: Optional reference text that corresponds to the audio.
                          This helps with spelling and context but transcription
                          will prioritize what is actually spoken.
    """
    # Get the audio file length to validate timestamps
    audio = AudioSegment.from_file(audio_path)
    audio_duration = len(audio) / 1000.0  # Convert to seconds
    
    all_words = get_segments(audio_path, source_lang, target_lang, reference_passage)

    # Extract filename and ID from audio path
    audio_filename = os.path.basename(audio_path)
    
    # Try to extract numeric ID from filename (e.g., "audio_student_04195.wav" -> 4195)
    # If not found, use hash of filename as fallback
    id_match = re.search(r'(\d+)', audio_filename)
    if id_match:
        file_id = int(id_match.group(1))
    else:
        # Use hash of filename as ID if no numbers found
        file_id = int(hashlib.md5(audio_filename.encode()).hexdigest()[:8], 16) % 100000
    
    # Process word-level data into annotations
    annotations = []
    
    for word_data in all_words:
        start_time = word_data["start"]
        end_time = word_data["end"]
        
        # Convert timestamp to seconds if needed
        if ":" in str(start_time):
            start_parts = str(start_time).split(":")
            if len(start_parts) == 3:  # H:MM:SS.mmm format
                start_seconds = float(start_parts[0]) * 3600 + float(start_parts[1]) * 60 + float(start_parts[2])
            else:  # MM:SS.mmm format
                start_seconds = float(start_parts[0]) * 60 + float(start_parts[1])
        else:
            start_seconds = float(start_time)
            
        if ":" in str(end_time):
            end_parts = str(end_time).split(":")
            if len(end_parts) == 3:  # H:MM:SS.mmm format
                end_seconds = float(end_parts[0]) * 3600 + float(end_parts[1]) * 60 + float(end_parts[2])
            else:  # MM:SS.mmm format
                end_seconds = float(end_parts[0]) * 60 + float(end_parts[1])
        else:
            end_seconds = float(end_time)
        
        # Ensure end time doesn't exceed audio duration
        if end_seconds > audio_duration:
            end_seconds = audio_duration
        
        # Create annotation entry with precise timestamps
        annotation_entry = {
            "start": format_timestamp_precise(start_seconds),
            "end": format_timestamp_precise(end_seconds),
            "Transcription": [word_data.get("word", "")]
        }
        
        annotations.append(annotation_entry)
    
    # Prepare output dictionary in the requested format
    output_data = {
        "id": file_id,
        "filename": audio_filename,
        "annotations": annotations
    }
    
    ensure_dir(os.path.dirname(output_json))
    save_json(output_data, output_json)
    
    # Print table format
    print("\n" + "="*100)
    print(f"{'Start Time':<20} {'End Time':<20} {'Transcription':<50}")
    print("="*100)
    for entry in annotations:
        transcription_text = entry['Transcription'][0] if entry['Transcription'] else ""
        print(f"{entry['start']:<20} {entry['end']:<20} {transcription_text:<50}")
    print("="*100)
    print(f"Total Annotations: {len(annotations)} | Audio Duration: {audio_duration:.3f}s")
    print(f"File ID: {file_id} | Filename: {audio_filename}")
    print("="*100 + "\n")
    
    return output_data

if __name__ == "__main__":
    import sys
    
    # Get audio path from command line argument
    if len(sys.argv) < 2:
        print("Usage: python audio_diarization.py <audio_file_path> [source_lang] [target_lang] [reference_passage_or_file]")
        print("Example: python audio_diarization.py audio.mp3 Gujarati English")
        print("Example with reference: python audio_diarization.py audio.mp3 Gujarati English \"આ એક ઉદાહરણ છે\"")
        print("Example with reference file: python audio_diarization.py audio.mp3 Gujarati English reference.txt")
        sys.exit(1)
    
    test_audio_path = sys.argv[1]
    source_lang = sys.argv[2] if len(sys.argv) > 2 else "Gujarati"
    target_lang = sys.argv[3] if len(sys.argv) > 3 else "English"
    
    # Handle optional reference passage parameter
    reference_passage = None
    if len(sys.argv) > 4:
        reference_arg = sys.argv[4]
        # Check if it's a file path
        if os.path.isfile(reference_arg):
            print(f"📖 Loading reference passage from file: {reference_arg}")
            with open(reference_arg, 'r', encoding='utf-8') as f:
                reference_passage = f.read().strip()
        else:
            # Treat it as direct text
            reference_passage = reference_arg
        
        if reference_passage:
            print(f"📝 Reference passage loaded ({len(reference_passage)} characters)")
            print(f"Preview: {reference_passage[:100]}{'...' if len(reference_passage) > 100 else ''}\n")
    
    # Create output directory
    audio_dir = os.path.dirname(test_audio_path) or "."
    output_dir = os.path.join(audio_dir, "transcriptions")
    ensure_dir(output_dir)
    test_output_json = os.path.join(output_dir, f"{Path(test_audio_path).stem}_word_transcription.json")
    
    try:
        start_time = time.time()
        print(f"\n{'='*100}")
        print(f"Processing Gujarati Audio: {test_audio_path}")
        print(f"Source Language: {source_lang}")
        print(f"Output: {test_output_json}")
        print(f"{'='*100}\n")
        
        result = process_diarization(
            audio_path=test_audio_path,
            output_json=test_output_json,
            source_lang=source_lang,
            target_lang=target_lang,
            reference_passage=reference_passage
        )
        
        if os.path.exists(test_output_json) and os.path.getsize(test_output_json) > 0:
            print(f"\n✓ Word-level transcription JSON successfully created: {test_output_json}")
            print(f"✓ File ID: {result['id']}")
            print(f"✓ Filename: {result['filename']}")
            print(f"✓ Total annotations: {len(result['annotations'])}")
            
            print("\n📋 Sample annotations (first 5):")
            for i, annotation in enumerate(result['annotations'][:5], 1):
                transcription = annotation['Transcription'][0] if annotation['Transcription'] else ""
                print(f"  {i}. [{annotation['start']} → {annotation['end']}] '{transcription}'")
        else:
            print(f"❌ ERROR: Transcription output file is missing or empty: {test_output_json}")
        
        elapsed_time = time.time() - start_time
        print('\n' + '='*100)
        print(f"✓ WORD-LEVEL TRANSCRIPTION COMPLETED in {elapsed_time:.2f} seconds")
        print('='*100 + '\n')
        
    except Exception as e:
        print(f"\n❌ ERROR: {str(e)}")
        import traceback
        traceback.print_exc()

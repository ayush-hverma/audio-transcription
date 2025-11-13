"""
Bengali Audio Transcription with Multi-Speaker Support and Emotion Detection

This module transcribes Bengali audio files with multiple speakers 
using Gemini 2.5 Flash and Vertex AI.

Features:
- Phrase/sentence-level timestamps with speaker identification
- Emotion detection for each speech segment
- Bengali script (বাংলা লিপি) transcription
- JSON output format matching production requirements
- Automatic speaker diarization
- Handles long audio files through automatic chunking
- End-of-speech detection
"""

import os
import json
import time
from pathlib import Path
import re
import random
from typing import Optional, Dict, List

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
    elif len(parts) == 3:  # H:MM:SS or MM:SS.mmm (legacy support)
        # Check if last part contains a decimal point
        if '.' in parts[2]:
            # Legacy MM:SS.mmm format
            minutes, seconds = parts[1], parts[2]
            return int(parts[0]) * 3600 + int(minutes) * 60 + float(seconds)
        else:
            # HH:MM:SS format without milliseconds
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


def has_bengali_script(text: str) -> bool:
    """Check if text contains Bengali script."""
    # Bengali Unicode range: U+0980 to U+09FF
    return any('\u0980' <= char <= '\u09FF' for char in text)


def validate_script_usage(items: List[Dict]) -> List[str]:
    """
    Validate that transcription uses Bengali script properly.
    Warns if inconsistencies are found.
    """
    warnings = []
    
    for i, item in enumerate(items):
        text = item.get('text', '')
        language = item.get('language', '')
        
        has_bengali = has_bengali_script(text)
        
        # Check if Bengali text is present
        if language == 'BEN':
            if not has_bengali:
                warnings.append(
                    f"Segment {i+1}: Tagged as BEN but no Bengali script found - \"{text[:50]}...\""
                )
    
    if warnings:
        print(f"\n⚠️ Script Validation Warnings ({len(warnings)} found):")
        for warning in warnings[:10]:  # Show first 10 warnings
            print(f"   {warning}")
        if len(warnings) > 10:
            print(f"   ... and {len(warnings) - 10} more warnings")
        print()
    else:
        print("✅ Script validation passed: All segments use Bengali script properly")
    
    return warnings


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


def transcribe_chunk_bengali(idx: int, chunk_path: str) -> tuple:
    """
    Transcribe a single audio chunk for Bengali with speaker identification.
    
    Args:
        idx: Chunk index
        chunk_path: Path to audio chunk file
    
    Returns:
        Tuple of (index, transcription_data)
    """
    model = GenerativeModel(MODEL_NAME)
    
    prompt = """
    ============================================================================
    BENGALI AUDIO TRANSCRIPTION - INSTRUCTIONS
    ============================================================================
    
    Listen to this Bengali audio file with multiple speakers and produce an accurate 
    PHRASE/SENTENCE-LEVEL transcription with timestamps, SPEAKER IDENTIFICATION, and SENTIMENT DETECTION.
    
    OBJECTIVE: 
    Generate precise Bengali phrase-level transcriptions with:
    - Accurate timestamps for each speech segment (phrase or sentence)
    - Speaker identification (Speaker A, Speaker B, Speaker C, etc.)
    - Language tagging: "BEN" (Bengali)
    - Sentiment detection for each segment
    - End-of-speech detection
    
    ============================================================================
    CRITICAL SCRIPT RULES - READ CAREFULLY
    ============================================================================
    
    MANDATORY SCRIPT RULES:
    
    1. BENGALI WORDS → Bengali Script (বাংলা লিপি)
       - All Bengali words must be written in Bengali script (Unicode range: U+0980 to U+09FF)
       - Use proper Bengali orthography and spelling
       - Include all necessary diacritical marks (মাত্রা, কার, ফলা)
    
    2. PROPER NOUNS:
       - Bengali proper nouns: Write in Bengali script
       - Foreign proper nouns (names, brands): Wrap in <proper-noun></proper-noun> tags
       - Example: "<proper-noun>ChatGPT</proper-noun>", "আমার নাম <proper-noun>Rahul</proper-noun>"
    
    CORRECT EXAMPLES:
    - "আমি আজ বাজারে গিয়েছিলাম এবং অনেক কিছু কিনেছি"
    - "এটা সত্যিই খুব ভালো লাগছে"
    - "তুমি কি <proper-noun>Kolkata</proper-noun> থেকে এসেছ?"
    
    SPEAKER DIARIZATION RULES:
    - Identify and label each distinct speaker as "Speaker A", "Speaker B", "Speaker C", etc.
    - Maintain consistency: the same voice should always get the same speaker label
    - Speaker changes should create new entries
    - If uncertain about a speaker, make your best estimate and stay consistent
    
    SENTIMENT DETECTION RULES (CRITICAL - DO NOT DEFAULT TO NEUTRAL):
    Analyze the speaker's VOCAL TONE, PITCH, SPEED, and ENERGY to detect emotions accurately.
    
    Available emotions and their vocal indicators:
    
    1. "happy" - Use when you hear:
       - Upbeat, energetic tone
       - Higher pitch or pitch variation
       - Laughter, chuckling, or smiling voice
       - Faster speech with enthusiasm
       - Positive exclamations (বাহ!, সুন্দর!, দারুণ!)
       
    2. "angry" - Use when you hear:
       - Loud, forceful voice
       - Sharp, cutting tone
       - Raised volume or intensity
       - Frustration or irritation in voice
       - Harsh emphasis on words
       
    3. "calm" - Use when you hear:
       - Relaxed, steady pace
       - Smooth, even tone
       - Measured, thoughtful delivery
       - Explaining or reasoning calmly
       - Reflective speech
       
    4. "polite" - Use when you hear:
       - Gentle, courteous tone
       - Formal or respectful manner
       - Soft voice with careful word choice
       - Seeking permission or being deferential
       - Using formal language markers (আপনি, দয়া করে)
       
    5. "excited" - Use when you hear:
       - High energy, animated voice
       - Fast-paced speech
       - Rising intonation patterns
       - Enthusiasm and eagerness
       - Exclamatory statements
       
    6. "sad" - Use when you hear:
       - Lower pitch, slower pace
       - Subdued or quiet voice
       - Hesitation or sighing
       - Melancholic or disappointed tone
       - Less energy in delivery
       
    7. "neutral" - Use ONLY when:
       - Strictly factual statements with no emotional coloring
       - Pure information delivery
       - No detectable emotion in voice
       WARNING: DO NOT use neutral as default! Listen carefully for emotions.

    8. "frustrated" - Use when you hear:
        - Frustrated, annoyed, or irritated tone with tension
        - Repetitive phrasing or exasperation sounds
        - Audible sighs or groans
        - Voice may waver between anger and helplessness
        - Less energy in delivery

    9. "persuasive" - Use when you hear:
        - Confident, deliberate tone
        - Emphasis on key words for influence
        - Positive, motivating language
        - Clear articulation and assertiveness
        - Rising-falling intonation patterns (trying to convince or motivate)

    10. "sarcastic" - Use when you hear:
        - Mocking or exaggerated tone
        - Overly positive language with negative implications
        - Smiling voice with irony
        - Rising-falling intonation patterns with a hint of mockery
        - Slight tone shift from positive to negative

    11. "empathetic" - Use when you hear:
        - Warm, caring tone
        - Soft, compassionate voice
        - Gentle pace with warmth
        - Genuine concern in tone
        - Soothing or reassuring delivery

    12. "confident" - Use when you hear:
        - Assertive, authoritative tone
        - Strong, confident voice
        - Fast, deliberate pace
        - Clear articulation with confidence
        - Expresses certainty or authority

    13. "nervous" - Use when you hear:
        - Uneven breathing or trembling tone
        - High-energy, anxious voice
        - Fast but soft speech with rapid breathing or occasional stuttering
        - Filler words or stammering
        - Sudden pitch rises or drops
    
    14. "surprised" - Use when you hear:
        - Sudden pitch rise or gasp, unexpected tone
        - High-energy, surprised voice
        - Short exclamations ("ও!", "কি!")
        - Quick tonal shift from neutral to excited
        - Voice may sound shocked or startled with sudden pitch rise or gasp
    
    15. "disgusted" - Use when you hear:
        - Harsh, nasal tone
        - Repetitive phrasing or exasperation sounds
        - Audible rejection sounds
        - Sharp pauses or clipped delivery
        - Voice may waver between frustration and anger

    EMOTION DETECTION STRATEGY:
    - Listen to HOW they say it, not just WHAT they say
    - Pay attention to voice modulation, tone changes, and energy
    - In conversations, people naturally show emotions - detect them!
    - If you hear ANY energy, enthusiasm, frustration, warmth, or intensity → it's NOT neutral
    - Conversations naturally have emotional variety - reflect this in your output
    - Aim for diverse emotions across the conversation (not all neutral)
    
    MANDATORY REQUIREMENTS:
    
    1. Timestamp Format:
       - Use format HH:MM:SS:mmm (hours:minutes:seconds:milliseconds)
       - Example: "00:00:03:450" means 3 seconds and 450 milliseconds
       - Milliseconds must be 3 digits (pad with zeros if needed: 050, 100, 000)
       - Ensure start < end for every entry
       - Keep entries in chronological order
       - Each entry represents a complete thought/phrase/sentence
    
    2. Speech Segmentation:
       - One entry per speech segment (phrase or sentence)
       - Natural pause or speaker change creates new entry
       - Keep related thoughts together in one segment
       - Don't make segments too long (max ~30 seconds)
    
    3. End of Speech Detection:
       - Set "end_of_speech": true for the LAST segment in the audio
       - Set "end_of_speech": false for all other segments
    
    4. Language Tagging:
       - Use "BEN" for Bengali language segments
    
    OUTPUT FORMAT (STRICT JSON SCHEMA):
    ```json
    [
        {
            "start": "HH:MM:SS:mmm",
            "end": "HH:MM:SS:mmm",
            "speaker": "Speaker A",
            "text": "complete Bengali phrase in Bengali script",
            "emotion": "neutral",
            "language": "BEN",
            "end_of_speech": false
        }
    ]
    ```
    
    EXAMPLE OUTPUT (showing proper Bengali script usage and emotion variety):
    [
        {
            "start": "00:00:05:000",
            "end": "00:00:10:500",
            "speaker": "Speaker A",
            "text": "আজকে আমি বাজারে গিয়েছিলাম এবং অনেক কিছু কিনেছি",
            "emotion": "happy",
            "language": "BEN",
            "end_of_speech": false
        },
        {
            "start": "00:00:12:200",
            "end": "00:00:18:750",
            "speaker": "Speaker B",
            "text": "তুমি কি সব্জি কিনেছ? আমাদের বাড়িতে আলু নেই",
            "emotion": "calm",
            "language": "BEN",
            "end_of_speech": false
        },
        {
            "start": "00:00:20:100",
            "end": "00:00:25:300",
            "speaker": "Speaker A",
            "text": "হ্যাঁ, আলু, পেঁয়াজ, টমেটো সব কিনেছি",
            "emotion": "polite",
            "language": "BEN",
            "end_of_speech": false
        },
        {
            "start": "00:00:27:400",
            "end": "00:00:32:900",
            "speaker": "Speaker B",
            "text": "বাহ! তুমি খুব ভালো কাজ করেছ!",
            "emotion": "excited",
            "language": "BEN",
            "end_of_speech": true
        }
    ]
    
    NOTE: In the above examples, observe how:
    - All Bengali words are written in Bengali script (বাংলা লিপি)
    - Proper use of Bengali orthography with all diacritical marks
    - Different emotions are detected based on vocal tone
    - Speakers are consistently labeled
    - Timestamps are in HH:MM:SS:mmm format (with milliseconds)
    
    CRITICAL OUTPUT REQUIREMENTS:
    - Return ONLY the JSON array wrapped in ```json ``` code block
    - Include ALL seven fields (start, end, speaker, text, emotion, language, end_of_speech) for every entry
    - Ensure valid JSON syntax
    - Arrange entries chronologically
    - Use "Speaker A", "Speaker B" format (not "Speaker 1", "Speaker 2")
    - Set end_of_speech to true ONLY for the last segment
    - NO explanatory text before or after the JSON
    - NO comments within the JSON
    
    EMOTION DETECTION IS MANDATORY:
    - DO NOT use "neutral" for all segments
    - DO NOT default to "neutral" when unsure
    - ACTIVELY listen for vocal cues, tone, pitch, and energy
    - Natural conversations have VARIED emotions - your output should reflect this
    - If someone is agreeing enthusiastically → "happy" or "excited"
    - If someone is explaining calmly → "calm" or "polite"
    - If someone sounds frustrated or emphatic → "angry" or "frustrated"
    - Aim for emotional diversity across segments (mix of different emotions)
    
    IMPORTANT: Listen to the AUDIO TONE and VOICE characteristics, not just the words!
    
    ============================================================================
    NOW: Process the audio and return ONLY the pure JSON array with:
    - Speaker-labeled transcription in Bengali script
    - Accurately detected emotions
    - Proper Bengali orthography
    - Proper language tags (BEN)
    ============================================================================
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


def transcribe_chunks(audio_path: str, duration: float) -> List[Dict]:
    """
    Transcribe audio by splitting into chunks and processing in parallel.
    
    Args:
        audio_path: Path to audio file
        duration: Audio duration in seconds
    
    Returns:
        Combined transcription data
    """
    chunks_dict = split_audio(audio_path)
    results = {}
    
    # Process chunks (can increase max_workers for faster processing)
    with ThreadPoolExecutor(max_workers=1) as executor:
        future_to_idx = {
            executor.submit(transcribe_chunk_bengali, idx, chunk_path): idx
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


def transcribe_bengali_audio(audio_path: str, output_json: str) -> List[Dict]:
    """
    Main function to transcribe Bengali audio with multiple speakers.
    
    Args:
        audio_path: Path to the input audio file (mp3, wav, etc.)
        output_json: Path to save the output JSON file
    
    Returns:
        List containing transcription results
    """
    print(f"\n{'='*100}")
    print(f"🎯 Bengali Multi-Speaker Transcription")
    print(f"{'='*100}")
    print(f"📁 Audio File: {audio_path}")
    print(f"💾 Output: {output_json}")
    print(f"🤖 Model: {MODEL_NAME}")
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
        idx, transcription_data = transcribe_chunk_bengali(0, audio_path)
    else:
        print(f"🎤 Audio is long. Splitting into {int(audio_duration / AUDIO_CHUNKING_OFFSET) + 1} chunks...")
        transcription_data = transcribe_chunks(audio_path, audio_duration)
    
    # Validate script usage
    print("\n📝 Validating Bengali script usage...")
    validation_warnings = validate_script_usage(transcription_data)
    
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
        has_bengali = has_bengali_script(text)
        script_display = "বাংলা লিপি (Bengali Script)" if has_bengali else "Unknown"
        
        print(f"\n[{i+1}] {segment['start']} → {segment['end']}")
        print(f"    Speaker: {segment.get('speaker', 'Unknown')} | Emotion: {segment.get('emotion', 'neutral')} | Language: {segment.get('language', 'Unknown')}")
        print(f"    Script: {script_display}")
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
    
    # Language statistics
    ben_segments = [s for s in transcription if s.get('language') == 'BEN']
    
    # Script usage statistics
    bengali_script_segments = [s for s in transcription if has_bengali_script(s.get('text', ''))]
    
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
                'BEN': 0,
                'emotions': {}
            }
        speaker_stats[speaker]['count'] += 1
        lang = segment.get('language', 'Unknown')
        if lang in speaker_stats[speaker]:
            speaker_stats[speaker][lang] += 1
        
        emotion = segment.get('emotion', 'neutral')
        speaker_stats[speaker]['emotions'][emotion] = speaker_stats[speaker]['emotions'].get(emotion, 0) + 1
    
    print(f"\n{'='*100}")
    print(f"📊 TRANSCRIPTION ANALYSIS")
    print(f"{'='*100}")
    print(f"📝 Total Segments: {len(transcription)}")
    
    print(f"\n📜 Script Usage Statistics:")
    print(f"   Bengali Script (বাংলা লিপি): {len(bengali_script_segments)} segments ({len(bengali_script_segments)/len(transcription)*100:.1f}%)")
    
    print(f"\n🌐 Language Distribution:")
    print(f"   Bengali (BEN): {len(ben_segments)} segments ({len(ben_segments)/len(transcription)*100:.1f}%)")
    
    print(f"\n😊 Emotion Distribution:")
    for emotion, count in sorted(emotion_stats.items(), key=lambda x: x[1], reverse=True):
        print(f"   {emotion.capitalize()}: {count} segments ({count/len(transcription)*100:.1f}%)")
    
    print(f"\n👥 Speaker Statistics:")
    for speaker, stats in sorted(speaker_stats.items()):
        print(f"\n   {speaker}:")
        print(f"      Total segments: {stats['count']}")
        print(f"      Bengali: {stats['BEN']} ({stats['BEN']/stats['count']*100:.1f}%)")
        print(f"      Top Emotions: {', '.join([f'{e}: {c}' for e, c in sorted(stats['emotions'].items(), key=lambda x: x[1], reverse=True)[:3]])}")
    
    print(f"{'='*100}\n")


if __name__ == "__main__":
    import sys
    
    if len(sys.argv) < 2:
        print("Usage: python bengali_transcription.py <audio_file> [output_file]")
        print("\nArguments:")
        print("  <audio_file>       Path to audio file (required)")
        print("  [output_file]      Output JSON file path (optional)")
        print("\nExamples:")
        print("  python bengali_transcription.py conversation.mp3")
        print("  python bengali_transcription.py conversation.mp3 output/result.json")
        print("\nSupported audio formats: mp3, wav, m4a, ogg, flac")
        sys.exit(1)
    
    # Get arguments
    audio_file = sys.argv[1]
    
    if len(sys.argv) > 2:
        output_file = sys.argv[2]
    else:
        # Auto-generate output filename
        output_dir = "transcriptions"
        ensure_dir(output_dir)
        output_file = os.path.join(
            output_dir,
            f"{Path(audio_file).stem}_bengali_transcription.json"
        )
    
    try:
        # Transcribe
        result = transcribe_bengali_audio(audio_file, output_file)
        
        # Analyze
        analyze_transcription(output_file)
        
        print("✅ All done! Check the output file for complete transcription.\n")
        
    except Exception as e:
        print(f"\n❌ ERROR: {str(e)}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


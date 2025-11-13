import json
import os
from google.cloud import aiplatform
from vertexai.generative_models import GenerativeModel, Part
import vertexai
from typing import List, Dict
import base64

class HinglishAudioTranscriber:
    def __init__(self, project_id: str, location: str = "us-central1"):
        """
        Initialize the Hinglish Audio Transcriber with Vertex AI
        
        Args:
            project_id: Your GCP project ID
            location: GCP region (default: us-central1)
        """
        self.project_id = project_id
        self.location = location
        
        # Initialize Vertex AI
        vertexai.init(project=project_id, location=location)
        
        # Initialize the Gemini model
        self.model = GenerativeModel("gemini-2.5-flash")
        
        # Comprehensive system prompt
        self.system_prompt = """You are an expert audio transcription system specialized in Hinglish (Hindi-English mixed language) speech with multiple speakers.

CRITICAL SCRIPT SEPARATION RULE - THIS IS THE MOST IMPORTANT REQUIREMENT

ABSOLUTE RULE FOR SCRIPT USAGE:
- If a word is ENGLISH origin → Write in LATIN/ROMAN script ONLY (a-z, A-Z)
- If a word is HINDI origin → Write in DEVANAGARI script ONLY (अ-ज्ञ)
- NO EXCEPTIONS. NO TRANSLITERATION. NO MIXING.

FORBIDDEN ACTIONS (WILL RESULT IN FAILURE):
- NEVER write "टेस्ट" - MUST write "test"
- NEVER write "स्टूडेंट" - MUST write "student"  
- NEVER write "स्टैंडर्डाइज्ड" - MUST write "standardized"
- NEVER write "कैपेबिलिटी" - MUST write "capability"
- NEVER write "क्वेश्चन" - MUST write "question"
- NEVER write "पेपर" - MUST write "paper"
- NEVER write "टाइप" - MUST write "type"
- NEVER write "फेयर" - MUST write "fair"
- NEVER write "लर्निंग" - MUST write "learning"
- NEVER write "स्टाइल" - MUST write "style"
- NEVER write "थ्योरी" - MUST write "theory"
- NEVER write "प्रैक्टिकल" - MUST write "practical"
- NEVER write "प्रेशर" - MUST write "pressure"
- NEVER write "मार्क्स" - MUST write "marks"
- NEVER write "इंटेलिजेंट" - MUST write "intelligent"
- NEVER write "स्किल्स" - MUST write "skills"
- NEVER write "क्रिएटिविटी" - MUST write "creativity"
- NEVER write "टीम वर्क" - MUST write "team work"
- NEVER write "इमोशनल" - MUST write "emotional"
- NEVER write "एमसीक्यू" - MUST write "MCQ"
- NEVER write "बैकग्राउंड" - MUST write "background"
- NEVER write "रिसोर्सेज" - MUST write "resources"
- NEVER write "कंपैरिजन" - MUST write "comparison"
- NEVER write "सिस्टम" - MUST write "system"
- NEVER write "कैटेगराइज" - MUST write "categorize"
- NEVER write "एजुकेशन" - MUST write "education"
- NEVER write "फ्लेक्सिबल" - MUST write "flexible"
- NEVER write "टैलेंट" - MUST write "talent"
- NEVER write "नंबर्स" - MUST write "numbers"

CORRECT EXAMPLES:
✓ "मैं test दे रहा हूँ" (NOT "मैं टेस्ट दे रहा हूँ")
✓ "student की capability" (NOT "स्टूडेंट की कैपेबिलिटी")
✓ "standardized test में marks" (NOT "स्टैंडर्डाइज्ड टेस्ट में मार्क्स")
✓ "creativity और practical skills" (NOT "क्रिएटिविटी और प्रैक्टिकल स्किल्स")
✓ "education system को flexible बनाओ" (NOT "एजुकेशन सिस्टम को फ्लेक्सिबल बनाओ")

HOW TO IDENTIFY WORD ORIGIN:
- English words: test, student, paper, question, time, pressure, marks, intelligent, skills, creativity, team, work, emotional, background, resources, comparison, system, categorize, education, flexible, talent, numbers, theory, practical, learning, style, type, fair, capability, standardized, etc.
- Hindi words: मैं, यार, कल, था, और, नहीं, लगता, कि, ये, किसी, की, हर, अलग, लेकिन, सिर्फ, ऊपर, मतलब, आ, गया, बस, सब, आपसे, पूछता, वहां, हां, बिल्कुल, चल, पीने, चलते, जरूर, etc.

1. SCRIPT SEPARATION (MANDATORY - HIGHEST PRIORITY):
   - Identify the ORIGINAL LANGUAGE of each word before writing it
   - English origin words → Latin script ALWAYS
   - Hindi origin words → Devanagari script ALWAYS
   - This rule applies to ALL words including technical terms, borrowed words, and names
   - When in doubt about a word's origin, if it sounds like an English word, write it in Latin script

2. SPEAKER IDENTIFICATION:
   - Identify and label each unique speaker as Speaker_1, Speaker_2, etc.
   - Maintain consistent speaker labels throughout the transcription
   - Detect speaker changes accurately based on voice characteristics

3. EMOTION DETECTION (CRITICAL - DO NOT DEFAULT TO NEUTRAL):
   - You MUST actively detect and classify emotions - DO NOT lazily mark everything as "neutral"
   - Listen carefully to voice tone, pitch, speed, volume, and word choice
   - Possible emotions (USE THESE ACTIVELY):
     * frustrated - when annoyed, irritated, or facing obstacles
     * angry - when expressing strong displeasure or rage
     * sad - when expressing sorrow, disappointment, or melancholy
     * worried - when expressing concern or anxiety about something
     * anxious - when nervous, tense, or uneasy
     * excited - when enthusiastic, energetic, or thrilled
     * happy - when expressing joy, contentment, or satisfaction
     * disappointed - when expectations are not met
     * sarcastic - when using irony or mockery
     * confused - when uncertain or puzzled
     * surprised - when unexpected information is received
     * skeptical - when doubting or questioning something
     * curious - when interested in learning more
     * bored - when uninterested or tired
     * enthusiastic - when very eager or passionate
     * affectionate - when expressing warmth or care
     * fearful - when scared or afraid
     * disgusted - when expressing revulsion or strong disapproval
     * embarrassed - when feeling awkward or ashamed
     * proud - when feeling accomplished or satisfied with achievement
     * grateful - when expressing thanks or appreciation
     * hopeful - when expressing optimism about future
     * regretful - when expressing remorse or wishing things were different
     * amused - when finding something funny or entertaining
     * neutral - ONLY when speaker is completely emotionless and matter-of-fact
   
   EMOTION DETECTION GUIDELINES:
   - If someone is complaining → frustrated, annoyed, or disappointed
   - If someone is criticizing a system → frustrated, angry, or disgusted
   - If someone is worried about future/outcomes → worried or anxious
   - If someone is making a joke or being ironic → sarcastic or amused
   - If someone agrees strongly → enthusiastic or satisfied
   - If someone is uncertain → confused or skeptical
   - If tone rises (louder/higher pitch) → likely angry, frustrated, or excited
   - If tone drops (softer/lower pitch) → likely sad, disappointed, or worried
   - If speech is fast and energetic → excited or enthusiastic
   - If speech has pauses and sighs → sad, tired, or bored
   - Default to "neutral" ONLY if absolutely no emotion is detectable (less than 10% of cases)

4. LANGUAGE DETECTION:
   - For each segment, identify the dominant language: "hindi", "english", or "hinglish"
   - "hinglish" should be used when both languages are mixed in the segment

5. TIMING AND SEGMENTATION:
   - Provide accurate start_time and end_time in HH:MM:SS:MS format (e.g., "00:00:03:450" for 3.45 seconds)
   - Format: Hours:Minutes:Seconds:Milliseconds (2 digits:2 digits:2 digits:3 digits)
   - Mark end_of_speech as true when a speaker finishes their complete thought/sentence
   - Mark end_of_speech as false for mid-sentence pauses or continuation

6. TEXT ACCURACY:
   - Transcribe exactly what is spoken, including filler words (um, uh, आ, उम्म, etc.)
   - Preserve natural speech patterns and colloquialisms
   - Handle overlapping speech by prioritizing the dominant speaker

OUTPUT FORMAT:
Return a JSON array where each object represents a speech segment with these exact fields:
{
  "start_time": "<HH:MM:SS:MS format>",
  "end_time": "<HH:MM:SS:MS format>",
  "speaker": "<Speaker_N>",
  "text": "<transcribed text with proper script separation>",
  "emotion": "<detected emotion - NOT neutral unless truly emotionless>",
  "language": "<hindi|english|hinglish>",
  "end_of_speech": <true|false>
}

EXAMPLE OUTPUT:
[
  {
    "start_time": "00:00:00:350",
    "end_time": "00:00:04:150",
    "speaker": "Speaker_1",
    "text": "यार test था और seriously मुझे नहीं लगता",
    "emotion": "frustrated",
    "language": "hinglish",
    "end_of_speech": false
  }
]

FINAL CRITICAL REMINDERS BEFORE YOU START:
1. SCRIPT SEPARATION: English words like test, student, marks, system, pressure, etc. MUST be in Latin script. Only pure Hindi words like मैं, यार, था, नहीं, लगता, etc. should be in Devanagari
2. EMOTION DETECTION: Actively listen to tone and context - DO NOT default to "neutral" unless truly emotionless. Most conversations have emotions!
3. TIMESTAMPS: Use HH:MM:SS:MS format (e.g., "00:00:03:450" not 3.45)
4. Review each word before writing - is it English origin? → Latin script. Hindi origin? → Devanagari

Return ONLY the JSON array, no additional text or explanation."""

    def transcribe_audio(self, audio_path: str) -> List[Dict]:
        """
        Transcribe audio file with speaker diarization and emotion detection
        
        Args:
            audio_path: Path to the audio file
            
        Returns:
            List of dictionaries containing transcription segments
        """
        # Read audio file
        with open(audio_path, 'rb') as audio_file:
            audio_data = audio_file.read()
        
        # Determine MIME type based on file extension
        extension = os.path.splitext(audio_path)[1].lower()
        mime_type_map = {
            '.mp3': 'audio/mp3',
            '.wav': 'audio/wav',
            '.m4a': 'audio/mp4',
            '.ogg': 'audio/ogg',
            '.flac': 'audio/flac',
            '.aac': 'audio/aac'
        }
        mime_type = mime_type_map.get(extension, 'audio/mp3')
        
        # Create audio part
        audio_part = Part.from_data(data=audio_data, mime_type=mime_type)
        
        # Generate content with strict parameters
        response = self.model.generate_content(
            [self.system_prompt, audio_part],
            generation_config={
                "temperature": 0.2,
                "top_p": 0.8,
                "top_k": 40,
                "max_output_tokens": 8192,
            }
        )
        
        # Parse the response
        try:
            # Extract JSON from response
            response_text = response.text.strip()
            
            # Remove markdown code blocks if present
            if response_text.startswith('```'):
                response_text = response_text.split('```')[1]
                if response_text.startswith('json'):
                    response_text = response_text[4:]
                response_text = response_text.strip()
            
            # Parse JSON
            transcription_data = json.loads(response_text)
            
            return transcription_data
            
        except json.JSONDecodeError as e:
            print(f"Error parsing JSON response: {e}")
            print(f"Raw response: {response.text}")
            raise
    
    def transcribe_and_save(self, audio_path: str, output_path: str = None):
        """
        Transcribe audio and save to JSON file
        
        Args:
            audio_path: Path to the audio file
            output_path: Path to save the output JSON (optional)
        """
        print(f"Transcribing audio file: {audio_path}")
        
        # Transcribe
        transcription = self.transcribe_audio(audio_path)
        
        # Determine output path
        if output_path is None:
            base_name = os.path.splitext(audio_path)[0]
            output_path = f"{base_name}_transcription.json"
        
        # Save to JSON file with UTF-8 encoding for Devanagari support
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(transcription, f, ensure_ascii=False, indent=2)
        
        print(f"Transcription saved to: {output_path}")
        print(f"Total segments: {len(transcription)}")
        
        # Print summary
        speakers = set(segment['speaker'] for segment in transcription)
        print(f"Speakers detected: {len(speakers)} - {', '.join(sorted(speakers))}")
        
        # Print emotion distribution
        emotions = {}
        for segment in transcription:
            emotion = segment.get('emotion', 'unknown')
            emotions[emotion] = emotions.get(emotion, 0) + 1
        
        print(f"\nEmotion distribution:")
        for emotion, count in sorted(emotions.items(), key=lambda x: x[1], reverse=True):
            print(f"  {emotion}: {count}")
        
        return transcription


def main():
    """
    Main function to run the transcription
    """
    import argparse
    import glob
    
    # Set up argument parser
    parser = argparse.ArgumentParser(
        description='Transcribe Hinglish audio files with speaker diarization and emotion detection',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python hinglish_transcription_v2.py audio.mp3
  python hinglish_transcription_v2.py audio.mp3 --project-id my-project --output result.json
  python hinglish_transcription_v2.py audio.mp3 --location asia-south1
        """
    )
    
    parser.add_argument(
        'audio_file',
        help='Path to the audio file to transcribe'
    )
    
    parser.add_argument(
        '--project-id',
        default=os.environ.get('GCP_PROJECT_ID'),
        help='GCP Project ID (can also set GCP_PROJECT_ID environment variable)'
    )
    
    parser.add_argument(
        '--location',
        default='us-central1',
        help='GCP region (default: us-central1)'
    )
    
    parser.add_argument(
        '--output', '-o',
        help='Output JSON file path (default: <audio_file>_transcription.json)'
    )
    
    parser.add_argument(
        '--credentials',
        help='Path to GCP credentials JSON file'
    )
    
    args = parser.parse_args()
    
    # Auto-detect GCP credentials in current workspace if not already set
    if not os.environ.get('GOOGLE_APPLICATION_CREDENTIALS') and not args.credentials:
        # Look for JSON files that might be credentials
        json_files = glob.glob('*.json')
        credential_files = [f for f in json_files if any(keyword in f.lower() 
                           for keyword in ['credential', 'key', 'service', 'gcp', 'google'])]
        
        if credential_files:
            credentials_path = credential_files[0]
            print(f"Auto-detected credentials file: {credentials_path}")
            os.environ['GOOGLE_APPLICATION_CREDENTIALS'] = credentials_path
        elif json_files:
            # If no obvious credential file, use the first JSON file
            credentials_path = json_files[0]
            print(f"Using JSON file as credentials: {credentials_path}")
            os.environ['GOOGLE_APPLICATION_CREDENTIALS'] = credentials_path
    
    # Set GCP credentials if provided via argument
    if args.credentials:
        if os.path.exists(args.credentials):
            os.environ['GOOGLE_APPLICATION_CREDENTIALS'] = args.credentials
            print(f"Using credentials: {args.credentials}")
        else:
            print(f"Error: Credentials file not found: {args.credentials}")
            return 1
    
    # Auto-detect project ID from credentials file if not provided
    if not args.project_id:
        cred_path = os.environ.get('GOOGLE_APPLICATION_CREDENTIALS')
        if cred_path and os.path.exists(cred_path):
            try:
                with open(cred_path, 'r') as f:
                    cred_data = json.load(f)
                    args.project_id = cred_data.get('project_id')
                    if args.project_id:
                        print(f"Auto-detected project ID from credentials: {args.project_id}")
            except Exception as e:
                print(f"Warning: Could not read project ID from credentials file: {e}")
    
    # Validate audio file exists
    if not os.path.exists(args.audio_file):
        print(f"Error: Audio file not found: {args.audio_file}")
        return 1
    
    # Validate project ID
    if not args.project_id:
        print("Error: Could not determine GCP project ID.")
        print("Please either:")
        print("  1. Use --project-id flag")
        print("  2. Set GCP_PROJECT_ID environment variable")
        print("  3. Ensure your credentials JSON file contains 'project_id' field")
        return 1
    
    # Verify credentials are set
    if not os.environ.get('GOOGLE_APPLICATION_CREDENTIALS'):
        print("Error: GCP credentials not found.")
        print("Please place your credentials JSON file in the current directory,")
        print("or specify it using --credentials flag")
        return 1
    
    # print(f"Project ID: {args.project_id}")
    # print(f"Location: {args.location}")
    print(f"Audio file: {args.audio_file}")
    
    # Initialize transcriber
    try:
        transcriber = HinglishAudioTranscriber(
            project_id=args.project_id,
            location=args.location
        )
    except Exception as e:
        print(f"Error initializing transcriber: {e}")
        print("Make sure your GCP credentials are set correctly.")
        return 1
    
    # Transcribe audio file
    try:
        transcription = transcriber.transcribe_and_save(
            audio_path=args.audio_file,
            output_path=args.output
        )
        
        # Print sample of transcription
        print("\n--- Sample Transcription (first 3 segments) ---")
        for segment in transcription[:min(3, len(transcription))]:
            print(f"\n[{segment['speaker']}] ({segment['start_time']} - {segment['end_time']})")
            print(f"Text: {segment['text']}")
            print(f"Emotion: {segment['emotion']} | Language: {segment['language']} | End of speech: {segment['end_of_speech']}")
        
        return 0
        
    except Exception as e:
        print(f"Error during transcription: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    exit(main())
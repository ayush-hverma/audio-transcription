"""
Flask Backend API for Audio Transcription with Word-Level Timestamps

This API provides endpoints for:
- Audio file upload and transcription
- Reference text comparison
- Word-level editing and saving
"""

from flask import Flask, request, jsonify, send_file, send_from_directory
from flask_cors import CORS
from werkzeug.utils import secure_filename
import os
import tempfile
import json
from pathlib import Path
import traceback
import time

import sys
from pathlib import Path

# Add parent directory to path to import from utils and pipeline
sys.path.insert(0, str(Path(__file__).parent.parent))

from backend.audio_diarization import process_diarization
from backend.multilingual_transcription import transcribe_audio as multilingual_transcribe
from pipeline.pipeline_config import LANGUAGE_CODES

app = Flask(__name__)
CORS(app)  # Enable CORS for frontend

# Configuration
UPLOAD_FOLDER = tempfile.mkdtemp()
OUTPUT_FOLDER = tempfile.mkdtemp()
AUDIO_FOLDER = os.path.join(UPLOAD_FOLDER, 'audio')
REFERENCE_FOLDER = os.path.join(UPLOAD_FOLDER, 'reference')
ALLOWED_AUDIO_EXTENSIONS = {'mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac'}
ALLOWED_TEXT_EXTENSIONS = {'txt'}
MAX_FILE_SIZE = 100 * 1024 * 1024  # 100 MB

# Create directories
os.makedirs(AUDIO_FOLDER, exist_ok=True)
os.makedirs(REFERENCE_FOLDER, exist_ok=True)
os.makedirs(OUTPUT_FOLDER, exist_ok=True)

app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['OUTPUT_FOLDER'] = OUTPUT_FOLDER
app.config['MAX_CONTENT_LENGTH'] = MAX_FILE_SIZE


def allowed_audio_file(filename):
    """Check if audio file extension is allowed."""
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_AUDIO_EXTENSIONS


def allowed_text_file(filename):
    """Check if text file extension is allowed."""
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_TEXT_EXTENSIONS


@app.route('/api/health', methods=['GET'])
def health_check():
    """Health check endpoint."""
    return jsonify({
        'status': 'healthy',
        'service': 'Audio Transcription Backend API',
        'version': '1.0.0'
    })


@app.route('/api/languages', methods=['GET'])
def get_languages():
    """Get list of supported languages."""
    try:
        languages = [
            {'code': lang, 'name': lang, 'script': script}
            for lang, script in LANGUAGE_CODES.items()
        ]
        
        return jsonify({
            'success': True,
            'languages': languages
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/transcribe', methods=['POST'])
def transcribe_audio():
    """
    Transcribe audio file with optional reference text.
    
    Form Parameters:
        - audio_file (required): Audio file to transcribe
        - source_language (required): Source language (e.g., 'Gujarati', 'Hindi')
        - target_language (optional): Target language (default: 'English')
        - reference_text (optional): Reference text content or file
    
    Returns:
        JSON response with transcription data including word-level timestamps
    """
    try:
        # Validate audio file
        if 'audio_file' not in request.files:
            return jsonify({
                'success': False,
                'error': 'No audio file provided'
            }), 400
        
        audio_file = request.files['audio_file']
        
        if audio_file.filename == '':
            return jsonify({
                'success': False,
                'error': 'No audio file selected'
            }), 400
        
        if not allowed_audio_file(audio_file.filename):
            return jsonify({
                'success': False,
                'error': f'Invalid audio format. Allowed: {", ".join(ALLOWED_AUDIO_EXTENSIONS)}'
            }), 400
        
        # Get parameters
        source_language = request.form.get('source_language', 'Gujarati')
        target_language = request.form.get('target_language', 'English')
        
        # Validate language
        if source_language not in LANGUAGE_CODES:
            return jsonify({
                'success': False,
                'error': f'Unsupported language: {source_language}'
            }), 400
        
        # Handle reference text
        reference_text = None
        
        # Check if reference text is provided as form field
        if 'reference_text' in request.form and request.form['reference_text'].strip():
            reference_text = request.form['reference_text'].strip()
        
        # Check if reference file is uploaded
        elif 'reference_file' in request.files:
            reference_file = request.files['reference_file']
            if reference_file.filename != '':
                if allowed_text_file(reference_file.filename):
                    reference_text = reference_file.read().decode('utf-8').strip()
                else:
                    return jsonify({
                        'success': False,
                        'error': 'Invalid reference file format. Only .txt files allowed'
                    }), 400
        
        # Save audio file
        filename = secure_filename(audio_file.filename)
        timestamp = int(time.time())
        unique_filename = f"{timestamp}_{filename}"
        audio_path = os.path.join(AUDIO_FOLDER, unique_filename)
        audio_file.save(audio_path)
        
        # Generate output filename
        output_filename = f"{Path(unique_filename).stem}_transcription.json"
        output_path = os.path.join(OUTPUT_FOLDER, output_filename)
        
        print(f"📁 Processing file: {filename}")
        print(f"🌐 Source Language: {source_language}")
        print(f"🎯 Target Language: {target_language}")
        if reference_text:
            print(f"📝 Reference text provided: {len(reference_text)} characters")
        
        # Process transcription
        result = process_diarization(
            audio_path=audio_path,
            output_json=output_path,
            source_lang=source_language,
            target_lang=target_language,
            reference_passage=reference_text
        )
        
        # Extract only the words array with required fields in exact order
        simplified_words = []
        for word_obj in result.get('words', []):
            simplified_words.append({
                'start': word_obj.get('start'),
                'word': word_obj.get('word'),
                'end': word_obj.get('end'),
                'duration': word_obj.get('duration'),
                'language': word_obj.get('language')
            })
        
        print(f"✅ Transcription completed: {len(simplified_words)} words")
        
        # Prepare response with minimal metadata (audio_path needed for frontend playback)
        response_data = {
            'words': simplified_words,
            'language': source_language,
            'audio_duration': result.get('audio_duration', 0),
            'total_words': len(simplified_words),
            'metadata': {
                'audio_path': f"/api/audio/{unique_filename}"
            }
        }
        
        # Add reference text only if provided (for frontend comparison)
        if reference_text:
            response_data['reference_text'] = reference_text
            response_data['has_reference'] = True
        
        return jsonify({
            'success': True,
            'data': response_data
        })
    
    except Exception as e:
        error_trace = traceback.format_exc()
        print(f"❌ Error during transcription: {str(e)}")
        print(error_trace)
        
        return jsonify({
            'success': False,
            'error': str(e),
            'error_type': type(e).__name__
        }), 500


@app.route('/api/audio/<filename>', methods=['GET'])
def serve_audio(filename):
    """Serve audio files."""
    try:
        return send_from_directory(AUDIO_FOLDER, filename)
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 404


@app.route('/api/transcription/<filename>', methods=['GET'])
def get_transcription(filename):
    """Get saved transcription by filename."""
    try:
        file_path = os.path.join(OUTPUT_FOLDER, filename)
        if not os.path.exists(file_path):
            return jsonify({
                'success': False,
                'error': 'Transcription file not found'
            }), 404
        
        with open(file_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        
        return jsonify({
            'success': True,
            'data': data
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/transcription/save', methods=['POST'])
def save_transcription():
    """
    Save edited transcription data.
    
    JSON Body:
        - filename: Original filename
        - words: Array of word objects with edited timestamps
    """
    try:
        data = request.get_json()
        
        if not data or 'filename' not in data or 'words' not in data:
            return jsonify({
                'success': False,
                'error': 'Missing required fields: filename and words'
            }), 400
        
        filename = secure_filename(data['filename'])
        words = data['words']
        
        # Create new output data
        output_data = {
            'words': words,
            'language': data.get('language', 'Unknown'),
            'audio_path': data.get('audio_path', ''),
            'audio_duration': data.get('audio_duration', 0),
            'total_words': len(words),
            'edited': True,
            'edited_timestamp': int(time.time())
        }
        
        # Save to file
        output_path = os.path.join(OUTPUT_FOLDER, filename)
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(output_data, f, ensure_ascii=False, indent=2)
        
        print(f"💾 Saved edited transcription: {filename}")
        
        return jsonify({
            'success': True,
            'message': 'Transcription saved successfully',
            'filename': filename
        })
    
    except Exception as e:
        error_trace = traceback.format_exc()
        print(f"❌ Error saving transcription: {str(e)}")
        print(error_trace)
        
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/transcription/download/<filename>', methods=['GET'])
def download_transcription(filename):
    """Download transcription file."""
    try:
        file_path = os.path.join(OUTPUT_FOLDER, filename)
        if not os.path.exists(file_path):
            return jsonify({
                'success': False,
                'error': 'File not found'
            }), 404
        
        return send_file(
            file_path,
            mimetype='application/json',
            as_attachment=True,
            download_name=filename
        )
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/transcribe/phrases', methods=['POST'])
def transcribe_phrases():
    """
    Transcribe audio file with phrase-level timestamps, speaker diarization, and emotion detection.
    
    Form Parameters:
        - audio_file (required): Audio file to transcribe
        - source_language (required): Language name or code (e.g., 'Gujarati', 'Hindi', 'GUJ')
        - reference_text (optional): Reference text for improved accuracy
    
    Returns:
        JSON response with phrase-level transcription data
    """
    try:
        # Validate audio file
        if 'audio_file' not in request.files:
            return jsonify({
                'success': False,
                'error': 'No audio file provided'
            }), 400
        
        audio_file = request.files['audio_file']
        
        if audio_file.filename == '':
            return jsonify({
                'success': False,
                'error': 'No audio file selected'
            }), 400
        
        if not allowed_audio_file(audio_file.filename):
            return jsonify({
                'success': False,
                'error': f'Invalid audio format. Allowed: {", ".join(ALLOWED_AUDIO_EXTENSIONS)}'
            }), 400
        
        # Get parameters
        source_language = request.form.get('source_language', 'Gujarati')
        reference_text = request.form.get('reference_text', None)
        
        if reference_text:
            reference_text = reference_text.strip()
            if not reference_text:
                reference_text = None
        
        # Save uploaded audio file
        filename = secure_filename(audio_file.filename)
        timestamp = int(time.time())
        unique_filename = f"{timestamp}_{filename}"
        audio_path = os.path.join(AUDIO_FOLDER, unique_filename)
        audio_file.save(audio_path)
        
        # Generate output filename
        output_filename = f"{Path(unique_filename).stem}_phrases_transcription.json"
        output_path = os.path.join(OUTPUT_FOLDER, output_filename)
        
        print(f"📁 Processing file: {filename}")
        print(f"🌐 Source Language: {source_language}")
        if reference_text:
            print(f"📝 Reference text provided: {len(reference_text)} characters")
        
        # Process transcription
        transcription_data = multilingual_transcribe(
            audio_path=audio_path,
            output_json=output_path,
            source_language=source_language,
            reference_text=reference_text
        )
        
        # Get audio duration from transcription data
        audio_duration = 0
        if transcription_data:
            last_phrase = transcription_data[-1]
            end_time = last_phrase.get('end', '00:00:00:000')
            # Parse timestamp to seconds
            parts = end_time.split(':')
            if len(parts) == 4:
                h, m, s, ms = parts
                audio_duration = int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000.0
        
        # Prepare simplified response
        response_data = {
            'phrases': transcription_data,
            'language': source_language,
            'audio_duration': audio_duration,
            'total_phrases': len(transcription_data),
            'metadata': {
                'filename': filename,
                'audio_path': f"/api/audio/{unique_filename}"
            }
        }
        
        # Add reference text if provided
        if reference_text:
            response_data['reference_text'] = reference_text
        
        print(f"✅ Transcription completed: {len(transcription_data)} phrases")
        
        return jsonify({
            'success': True,
            'data': response_data
        })
    
    except Exception as e:
        error_trace = traceback.format_exc()
        print(f"❌ Error during transcription: {str(e)}")
        print(error_trace)
        
        return jsonify({
            'success': False,
            'error': str(e),
            'error_type': type(e).__name__
        }), 500


@app.errorhandler(413)
def request_entity_too_large(error):
    """Handle file too large error."""
    return jsonify({
        'success': False,
        'error': f'File too large. Maximum size: {MAX_FILE_SIZE / (1024 * 1024)} MB'
    }), 413


@app.errorhandler(500)
def internal_server_error(error):
    """Handle internal server errors."""
    return jsonify({
        'success': False,
        'error': 'Internal server error occurred'
    }), 500


if __name__ == '__main__':
    print("\n" + "="*100)
    print("🚀 Starting Audio Transcription Backend API")
    print("="*100)
    print(f"📁 Audio folder: {AUDIO_FOLDER}")
    print(f"📁 Reference folder: {REFERENCE_FOLDER}")
    print(f"💾 Output folder: {OUTPUT_FOLDER}")
    print(f"📊 Max file size: {MAX_FILE_SIZE / (1024 * 1024)} MB")
    print(f"🎵 Allowed audio formats: {', '.join(ALLOWED_AUDIO_EXTENSIONS)}")
    print("="*100)
    print("\n🌐 API Endpoints:")
    print("   GET  /api/health                      - Health check")
    print("   GET  /api/languages                   - Get supported languages")
    print("   POST /api/transcribe                  - Transcribe audio (word-level)")
    print("   POST /api/transcribe/phrases          - Transcribe audio (phrase-level with emotions)")
    print("   GET  /api/audio/<filename>            - Serve audio file")
    print("   GET  /api/transcription/<filename>    - Get transcription")
    print("   POST /api/transcription/save          - Save edited transcription")
    print("   GET  /api/transcription/download/<f>  - Download transcription")
    print("="*100 + "\n")
    
    # Run server
    app.run(
        host='0.0.0.0',
        port=5001,
        debug=True,
        threaded=True
    )


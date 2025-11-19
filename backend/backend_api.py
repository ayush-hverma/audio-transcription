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
from utils.storage import StorageManager
from dotenv import load_dotenv
from pathlib import Path

# Load environment variables from backend directory
backend_dir = Path(__file__).parent
env_path = backend_dir / '.env'
load_dotenv(dotenv_path=env_path)

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

# Initialize storage manager
storage_manager = StorageManager()


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
        
        # Get audio duration from the audio file
        from pydub import AudioSegment
        audio = AudioSegment.from_file(audio_path)
        audio_duration = len(audio) / 1000.0  # Convert to seconds
        
        # Extract words from annotations
        # result structure: {"id": ..., "filename": ..., "annotations": [...]}
        # Each annotation: {"start": "H:MM:SS.mmm", "end": "H:MM:SS.mmm", "Transcription": ["word"]}
        simplified_words = []
        annotations = result.get('annotations', [])
        
        for annotation in annotations:
            # Extract word from Transcription array
            transcription_list = annotation.get('Transcription', [])
            word_text = transcription_list[0] if transcription_list else ''
            
            start_time = annotation.get('start', '')
            end_time = annotation.get('end', '')
            
            # Calculate duration in seconds
            duration = 0
            if start_time and end_time:
                # Convert timestamps to seconds for duration calculation
                def timestamp_to_seconds(ts):
                    parts = ts.split(':')
                    if len(parts) == 3:  # H:MM:SS.mmm
                        return float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2])
                    elif len(parts) == 2:  # MM:SS.mmm
                        return float(parts[0]) * 60 + float(parts[1])
                    return float(ts)
                
                start_sec = timestamp_to_seconds(start_time)
                end_sec = timestamp_to_seconds(end_time)
                duration = end_sec - start_sec
            
            simplified_words.append({
                'start': start_time,
                'word': word_text,
                'end': end_time,
                'duration': duration,
                'language': source_language
            })
        
        print(f"✅ Transcription completed: {len(simplified_words)} words")
        print(f"   Audio duration: {audio_duration:.3f}s")
        
        # Prepare response with minimal metadata (audio_path needed for frontend playback)
        response_data = {
            'words': simplified_words,
            'language': source_language,
            'audio_duration': audio_duration,
            'total_words': len(simplified_words),
            'metadata': {
                'filename': filename,  # Original filename for renaming
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


@app.route('/api/audio/s3-proxy', methods=['GET'])
def proxy_s3_audio():
    """
    Proxy audio files from S3 to avoid CORS issues.
    
    Query Parameters:
        - url: S3 URL of the audio file
        - key: S3 key (alternative to url)
    """
    try:
        import requests
        from io import BytesIO
        
        s3_url = request.args.get('url')
        s3_key = request.args.get('key')
        
        if not s3_url and not s3_key:
            return jsonify({
                'success': False,
                'error': 'Either url or key parameter is required'
            }), 400
        
        # If key is provided, construct URL
        if s3_key and not s3_url:
            bucket_name = storage_manager.s3_bucket_name
            region = storage_manager.s3_region
            s3_url = f"https://{bucket_name}.s3.{region}.amazonaws.com/{s3_key}"
        
        # Use boto3 to get the object from S3 (handles authentication)
        if storage_manager.s3_client:
            try:
                # Parse bucket and key from URL
                # URL format: https://bucket.s3.region.amazonaws.com/key
                # Example: https://audio-files-transcripn.s3.ap-south-1.amazonaws.com/audio/file.mp3
                
                if s3_key:
                    # If key is provided, use it directly
                    bucket = storage_manager.s3_bucket_name
                    key = s3_key
                else:
                    # Parse from URL
                    # Remove https://
                    url_without_protocol = s3_url.replace('https://', '').replace('http://', '')
                    
                    # Split by .s3. to get bucket and rest
                    if '.s3.' in url_without_protocol:
                        parts = url_without_protocol.split('.s3.', 1)
                        bucket = parts[0]
                        # Get everything after .amazonaws.com/ as the key
                        if '.amazonaws.com/' in parts[1]:
                            key = parts[1].split('.amazonaws.com/', 1)[1]
                        else:
                            # Fallback: try to extract from path
                            key = s3_url.split('.amazonaws.com/', 1)[1] if '.amazonaws.com/' in s3_url else s3_url.split('/')[-1]
                    else:
                        # Fallback parsing
                        bucket = storage_manager.s3_bucket_name
                        key = s3_url.split('/')[-1]
                
                print(f"📦 Fetching from S3: bucket={bucket}, key={key}")
                
                # Get object from S3
                response = storage_manager.s3_client.get_object(Bucket=bucket, Key=key)
                
                # Get content type
                content_type = response.get('ContentType', 'audio/mpeg')
                
                # Stream the file
                from flask import Response
                return Response(
                    response['Body'].read(),
                    mimetype=content_type,
                    headers={
                        'Content-Disposition': f'inline; filename="{key.split("/")[-1]}"',
                        'Access-Control-Allow-Origin': '*',
                        'Cache-Control': 'public, max-age=3600'
                    }
                )
            except Exception as s3_error:
                print(f"Error fetching from S3: {str(s3_error)}")
                # Fallback to direct URL fetch (may still have CORS issues)
                pass
        
        # Fallback: try direct fetch (may fail due to CORS, but worth trying)
        try:
            response = requests.get(s3_url, stream=True, timeout=30)
            response.raise_for_status()
            
            content_type = response.headers.get('Content-Type', 'audio/mpeg')
            
            from flask import Response
            return Response(
                response.content,
                mimetype=content_type,
                headers={
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'public, max-age=3600'
                }
            )
        except Exception as fetch_error:
            return jsonify({
                'success': False,
                'error': f'Failed to fetch audio: {str(fetch_error)}'
            }), 500
    
    except Exception as e:
        error_trace = traceback.format_exc()
        print(f"❌ Error proxying S3 audio: {str(e)}")
        print(error_trace)
        
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


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
        
        # Get audio duration from the audio file
        from pydub import AudioSegment
        audio = AudioSegment.from_file(audio_path)
        audio_duration = len(audio) / 1000.0  # Convert to seconds
        
        # Calculate duration for each phrase and add it to the phrase object
        def timestamp_to_seconds(ts: str) -> float:
            """Convert timestamp string to seconds."""
            parts = ts.split(':')
            if len(parts) == 4:  # HH:MM:SS:mmm
                return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2]) + float(parts[3]) / 1000.0
            elif len(parts) == 3:  # H:MM:SS.mmm
                return float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2])
            elif len(parts) == 2:  # MM:SS.mmm
                return float(parts[0]) * 60 + float(parts[1])
            return float(ts)
        
        # Add duration to each phrase
        processed_phrases = []
        for phrase in transcription_data:
            start_time = phrase.get('start', '00:00:00:000')
            end_time = phrase.get('end', '00:00:00:000')
            
            start_seconds = timestamp_to_seconds(start_time)
            end_seconds = timestamp_to_seconds(end_time)
            duration = end_seconds - start_seconds
            
            # Add duration field to phrase
            phrase_with_duration = phrase.copy()
            phrase_with_duration['duration'] = duration
            processed_phrases.append(phrase_with_duration)
        
        # Prepare simplified response
        response_data = {
            'phrases': processed_phrases,
            'language': source_language,
            'audio_duration': audio_duration,
            'total_phrases': len(processed_phrases),
            'metadata': {
                'filename': filename,  # Original filename for renaming
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


@app.route('/api/transcription/save-to-database', methods=['POST'])
def save_to_database():
    """
    Save audio file to S3 and transcription data to MongoDB.
    
    JSON Body:
        - audio_filename: Filename of the audio file (from metadata.audio_path)
        - transcription_data: Complete transcription data (words/phrases, metadata, etc.)
        - transcription_type: Type of transcription ('words' or 'phrases')
        - user_id: User ID (from Google OAuth, typically the 'sub' field)
    
    Headers:
        - X-User-ID: User ID (alternative to JSON body)
    """
    try:
        data = request.get_json()
        
        if not data:
            return jsonify({
                'success': False,
                'error': 'No data provided'
            }), 400
        
        # Get user_id from request body or headers
        user_id = data.get('user_id') or request.headers.get('X-User-ID')
        
        if not user_id:
            return jsonify({
                'success': False,
                'error': 'user_id is required. Please provide it in the request body or X-User-ID header.'
            }), 400
        
        # Extract audio filename from audio_path or use provided filename
        audio_path = data.get('audio_path', '')
        audio_filename = data.get('audio_filename', '')
        
        # Parse audio filename from path if needed
        if audio_path and not audio_filename:
            # Extract filename from path like "/api/audio/1234567890_filename.mp3"
            audio_filename = audio_path.split('/')[-1] if '/' in audio_path else audio_path
        
        if not audio_filename:
            return jsonify({
                'success': False,
                'error': 'Audio filename is required'
            }), 400
        
        # Get local audio file path
        local_audio_path = os.path.join(AUDIO_FOLDER, audio_filename)
        
        if not os.path.exists(local_audio_path):
            return jsonify({
                'success': False,
                'error': f'Audio file not found: {audio_filename}'
            }), 404
        
        # Get transcription data
        transcription_data = data.get('transcription_data')
        if not transcription_data:
            return jsonify({
                'success': False,
                'error': 'Transcription data is required'
            }), 400
        
        # Save to S3 and MongoDB
        result = storage_manager.save_transcription(
            local_audio_path=local_audio_path,
            transcription_data=transcription_data,
            original_filename=audio_filename,
            user_id=user_id
        )
        
        if result['success']:
            print(f"💾 Saved transcription to database: {result.get('mongodb_id')}")
            return jsonify({
                'success': True,
                'message': result.get('message', 'Data saved successfully'),
                's3_metadata': result.get('s3_metadata'),
                'mongodb_id': result.get('mongodb_id')
            })
        else:
            return jsonify({
                'success': False,
                'error': result.get('error', 'Failed to save data')
            }), 500
    
    except Exception as e:
        error_trace = traceback.format_exc()
        print(f"❌ Error saving to database: {str(e)}")
        print(error_trace)
        
        return jsonify({
            'success': False,
            'error': str(e),
            'error_type': type(e).__name__
        }), 500


@app.route('/api/transcriptions', methods=['GET'])
def list_transcriptions():
    """
    List saved transcriptions from MongoDB for the authenticated user.
    
    Query Parameters:
        - limit: Maximum number of results (default: 100)
        - skip: Number of results to skip (default: 0)
    
    Headers:
        - X-User-ID: User ID (required)
    """
    try:
        # Get user_id from headers
        user_id = request.headers.get('X-User-ID')
        
        if not user_id:
            return jsonify({
                'success': False,
                'error': 'user_id is required. Please provide it in the X-User-ID header.'
            }), 400
        
        limit = int(request.args.get('limit', 100))
        skip = int(request.args.get('skip', 0))
        
        result = storage_manager.list_transcriptions(limit=limit, skip=skip, user_id=user_id)
        
        if result['success']:
            return jsonify({
                'success': True,
                'data': result
            })
        else:
            return jsonify({
                'success': False,
                'error': result.get('error', 'Failed to list transcriptions')
            }), 500
    
    except Exception as e:
        error_trace = traceback.format_exc()
        print(f"❌ Error listing transcriptions: {str(e)}")
        print(error_trace)
        
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/transcriptions/<transcription_id>', methods=['GET'])
def get_transcription_by_id(transcription_id):
    """
    Get a single transcription by MongoDB document ID.
    
    Headers:
        - X-User-ID: User ID (required)
    """
    try:
        # Get user_id from headers
        user_id = request.headers.get('X-User-ID')
        
        if not user_id:
            return jsonify({
                'success': False,
                'error': 'user_id is required. Please provide it in the X-User-ID header.'
            }), 400
        
        document = storage_manager.get_transcription(transcription_id, user_id=user_id)
        
        if document:
            return jsonify({
                'success': True,
                'data': document
            })
        else:
            return jsonify({
                'success': False,
                'error': 'Transcription not found or you do not have permission to access it'
            }), 404
    
    except Exception as e:
        error_trace = traceback.format_exc()
        print(f"❌ Error getting transcription: {str(e)}")
        print(error_trace)
        
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/transcriptions/<transcription_id>', methods=['PUT'])
def update_transcription_by_id(transcription_id):
    """
    Update a transcription in MongoDB.
    
    JSON Body:
        - transcription_data: Updated transcription data
    
    Headers:
        - X-User-ID: User ID (required)
    """
    try:
        # Get user_id from headers
        user_id = request.headers.get('X-User-ID')
        
        if not user_id:
            return jsonify({
                'success': False,
                'error': 'user_id is required. Please provide it in the X-User-ID header.'
            }), 400
        
        data = request.get_json()
        
        if not data or 'transcription_data' not in data:
            return jsonify({
                'success': False,
                'error': 'transcription_data is required'
            }), 400
        
        transcription_data = data['transcription_data']
        
        result = storage_manager.update_transcription(transcription_id, transcription_data, user_id=user_id)
        
        if result['success']:
            return jsonify({
                'success': True,
                'message': result.get('message', 'Transcription updated successfully'),
                'document_id': result.get('document_id')
            })
        else:
            return jsonify({
                'success': False,
                'error': result.get('error', 'Failed to update transcription')
            }), 500
    
    except Exception as e:
        error_trace = traceback.format_exc()
        print(f"❌ Error updating transcription: {str(e)}")
        print(error_trace)
        
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/transcriptions/<transcription_id>', methods=['DELETE'])
def delete_transcription_by_id(transcription_id):
    """
    Delete a transcription from MongoDB.
    
    Headers:
        - X-User-ID: User ID (required)
    """
    try:
        # Get user_id from headers
        user_id = request.headers.get('X-User-ID')
        
        if not user_id:
            return jsonify({
                'success': False,
                'error': 'user_id is required. Please provide it in the X-User-ID header.'
            }), 400
        
        result = storage_manager.delete_transcription(transcription_id, user_id=user_id)
        
        if result['success']:
            return jsonify({
                'success': True,
                'message': result.get('message', 'Transcription deleted successfully'),
                'document_id': result.get('document_id')
            })
        else:
            return jsonify({
                'success': False,
                'error': result.get('error', 'Failed to delete transcription')
            }), 500
    
    except Exception as e:
        error_trace = traceback.format_exc()
        print(f"❌ Error deleting transcription: {str(e)}")
        print(error_trace)
        
        return jsonify({
            'success': False,
            'error': str(e)
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
    print("   GET  /api/audio/s3-proxy              - Proxy S3 audio (CORS fix)")
    print("   GET  /api/transcription/<filename>    - Get transcription")
    print("   POST /api/transcription/save          - Save edited transcription")
    print("   POST /api/transcription/save-to-database - Save to S3 and MongoDB")
    print("   GET  /api/transcription/download/<f>  - Download transcription")
    print("   GET  /api/transcriptions              - List all saved transcriptions")
    print("   GET  /api/transcriptions/<id>         - Get transcription by ID")
    print("   PUT  /api/transcriptions/<id>         - Update transcription by ID")
    print("   DELETE /api/transcriptions/<id>       - Delete transcription by ID")
    print("="*100 + "\n")
    
    # Run server
    import os
    debug_mode = os.getenv('FLASK_ENV') != 'production'
    port = int(os.getenv('FLASK_PORT', '5002'))  # Default to 5002 (available port in 5000-8000 range)
    app.run(
        host='0.0.0.0',
        port=port,
        debug=debug_mode,
        threaded=True
    )


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
import bcrypt
from pymongo import MongoClient
from datetime import datetime, timezone

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

# Initialize MongoDB connection for users
mongodb_uri = os.getenv('MONGODB_URI', 'mongodb://localhost:27017/')
mongodb_database = os.getenv('MONGODB_DATABASE', 'transcription_db')
try:
    mongo_client = MongoClient(mongodb_uri)
    mongo_db = mongo_client[mongodb_database]
    users_collection = mongo_db['users']
    # Test connection
    mongo_client.admin.command('ping')
    print(f"✅ Connected to MongoDB for user authentication: {mongodb_database}")
except Exception as e:
    print(f"❌ Warning: Could not connect to MongoDB for user authentication: {str(e)}")
    users_collection = None


def get_user_from_request():
    """
    Get user information from request headers (X-User-ID and X-Is-Admin).
    Returns tuple: (user_id, is_admin)
    """
    user_id = request.headers.get('X-User-ID')
    is_admin_str = request.headers.get('X-Is-Admin', 'false').lower()
    is_admin = is_admin_str == 'true'
    return user_id, is_admin


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


@app.route('/api/auth/login', methods=['POST'])
def login():
    """
    Authenticate user with username and password.
    
    JSON Body:
        - username: User's username
        - password: User's password
    
    Returns:
        JSON response with user information on success
    """
    try:
        if not users_collection:
            return jsonify({
                'success': False,
                'error': 'User authentication service unavailable. Please check MongoDB connection.'
            }), 500
        
        data = request.get_json()
        
        if not data:
            return jsonify({
                'success': False,
                'error': 'No data provided'
            }), 400
        
        username = data.get('username', '').strip()
        password = data.get('password', '')
        
        if not username or not password:
            return jsonify({
                'success': False,
                'error': 'Username and password are required'
            }), 400
        
        # Find user by username
        user = users_collection.find_one({'username': username})
        
        if not user:
            return jsonify({
                'success': False,
                'error': 'Invalid username or password'
            }), 401
        
        # Verify password
        password_hash = user.get('password_hash', '')
        if not password_hash:
            return jsonify({
                'success': False,
                'error': 'User account error. Please contact administrator.'
            }), 500
        
        # Check password
        if not bcrypt.checkpw(password.encode('utf-8'), password_hash.encode('utf-8')):
            return jsonify({
                'success': False,
                'error': 'Invalid username or password'
            }), 401
        
        # Update last login time
        users_collection.update_one(
            {'_id': user['_id']},
            {'$set': {'last_login': datetime.now(timezone.utc), 'updated_at': datetime.now(timezone.utc)}}
        )
        
        # Return user info (without password hash)
        is_admin = user.get('is_admin', False)
        user_info = {
            'id': str(user['_id']),
            'username': user.get('username', ''),
            'email': user.get('email', ''),
            'name': user.get('name', ''),
            'is_admin': is_admin,
            'created_at': user.get('created_at', datetime.now(timezone.utc)).isoformat() if isinstance(user.get('created_at'), datetime) else user.get('created_at')
        }
        
        print(f"✅ User logged in: {username}")
        
        return jsonify({
            'success': True,
            'user': user_info,
            'message': 'Login successful'
        })
    
    except Exception as e:
        error_trace = traceback.format_exc()
        print(f"❌ Error during login: {str(e)}")
        print(error_trace)
        
        return jsonify({
            'success': False,
            'error': 'An error occurred during login. Please try again.'
        }), 500


@app.route('/api/auth/register', methods=['POST'])
def register():
    """
    Register a new user account.
    
    JSON Body:
        - username: Desired username (must be unique)
        - password: User's password
        - email: User's email (optional)
        - name: User's full name (optional)
    
    Returns:
        JSON response with user information on success
    """
    try:
        if not users_collection:
            return jsonify({
                'success': False,
                'error': 'User registration service unavailable. Please check MongoDB connection.'
            }), 500
        
        data = request.get_json()
        
        if not data:
            return jsonify({
                'success': False,
                'error': 'No data provided'
            }), 400
        
        username = data.get('username', '').strip()
        password = data.get('password', '')
        email = data.get('email', '').strip()
        name = data.get('name', '').strip()
        
        if not username or not password:
            return jsonify({
                'success': False,
                'error': 'Username and password are required'
            }), 400
        
        if len(password) < 6:
            return jsonify({
                'success': False,
                'error': 'Password must be at least 6 characters long'
            }), 400
        
        # Check if username already exists
        existing_user = users_collection.find_one({'username': username})
        if existing_user:
            return jsonify({
                'success': False,
                'error': 'Username already exists'
            }), 409
        
        # Hash password
        salt = bcrypt.gensalt()
        password_hash = bcrypt.hashpw(password.encode('utf-8'), salt).decode('utf-8')
        
        # Create user document
        user_doc = {
            'username': username,
            'password_hash': password_hash,
            'email': email or f'{username}@example.com',
            'name': name or username,
            'created_at': datetime.now(timezone.utc),
            'updated_at': datetime.now(timezone.utc)
        }
        
        # Insert user
        result = users_collection.insert_one(user_doc)
        
        # Return user info (without password hash)
        user_info = {
            'id': str(result.inserted_id),
            'username': username,
            'email': user_doc['email'],
            'name': user_doc['name'],
            'created_at': user_doc['created_at'].isoformat()
        }
        
        print(f"✅ New user registered: {username}")
        
        return jsonify({
            'success': True,
            'user': user_info,
            'message': 'Registration successful'
        }), 201
    
    except Exception as e:
        error_trace = traceback.format_exc()
        print(f"❌ Error during registration: {str(e)}")
        print(error_trace)
        
        return jsonify({
            'success': False,
            'error': 'An error occurred during registration. Please try again.'
        }), 500


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
    User ID is optional - if provided, it will be stored for tracking purposes.
    
    JSON Body:
        - audio_filename: Filename of the audio file (from metadata.audio_path)
        - transcription_data: Complete transcription data (words/phrases, metadata, etc.)
        - transcription_type: Type of transcription ('words' or 'phrases')
        - user_id: User ID (optional, for tracking who created the transcription)
    
    Headers:
        - X-User-ID: User ID (optional, alternative to JSON body)
    """
    try:
        data = request.get_json()
        
        if not data:
            return jsonify({
                'success': False,
                'error': 'No data provided'
            }), 400
        
        # Get user_id from request body or headers (optional)
        user_id = data.get('user_id') or request.headers.get('X-User-ID') or 'anonymous'
        
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
        
        # Save to S3 and MongoDB (user_id is optional, defaults to 'anonymous')
        result = storage_manager.save_transcription(
            local_audio_path=local_audio_path,
            transcription_data=transcription_data,
            original_filename=audio_filename,
            user_id=user_id or 'anonymous'
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
    List saved transcriptions from MongoDB.
    Regular users can only see transcriptions assigned to them.
    Admins can see all transcriptions.
    
    Headers:
        - X-User-ID: User ID (required for non-admin users)
        - X-Is-Admin: 'true' or 'false' (default: 'false')
    
    Query Parameters:
        - limit: Maximum number of results (default: 100)
        - skip: Number of results to skip (default: 0)
    """
    try:
        limit = int(request.args.get('limit', 100))
        skip = int(request.args.get('skip', 0))
        
        # Get user info from headers
        user_id, is_admin = get_user_from_request()
        
        # For non-admin users, user_id is required
        if not is_admin and not user_id:
            return jsonify({
                'success': False,
                'error': 'User ID is required. Please provide X-User-ID header.'
            }), 400
        
        result = storage_manager.list_transcriptions(
            limit=limit, 
            skip=skip, 
            user_id=user_id, 
            is_admin=is_admin
        )
        
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
    Regular users can only access transcriptions assigned to them.
    Admins can access all transcriptions.
    
    Headers:
        - X-User-ID: User ID (required for non-admin users)
        - X-Is-Admin: 'true' or 'false' (default: 'false')
    """
    try:
        # Get user info from headers
        user_id, is_admin = get_user_from_request()
        
        # For non-admin users, user_id is required
        if not is_admin and not user_id:
            return jsonify({
                'success': False,
                'error': 'User ID is required. Please provide X-User-ID header.'
            }), 400
        
        document = storage_manager.get_transcription(
            transcription_id, 
            user_id=user_id, 
            is_admin=is_admin
        )
        
        if document:
            return jsonify({
                'success': True,
                'data': document
            })
        else:
            return jsonify({
                'success': False,
                'error': 'Transcription not found or access denied'
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
    Update a transcription in MongoDB (all users can update all data).
    
    JSON Body:
        - transcription_data: Updated transcription data
    """
    try:
        data = request.get_json()
        
        if not data or 'transcription_data' not in data:
            return jsonify({
                'success': False,
                'error': 'transcription_data is required'
            }), 400
        
        transcription_data = data['transcription_data']
        
        result = storage_manager.update_transcription(transcription_id, transcription_data)
        
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


@app.route('/api/admin/transcriptions/<transcription_id>/assign', methods=['POST'])
def assign_transcription(transcription_id):
    """
    Assign a transcription to a user (admin only).
    
    Headers:
        - X-Is-Admin: 'true' (required)
    
    JSON Body:
        - assigned_user_id: User ID to assign the transcription to
    """
    try:
        print(f"📝 Assign transcription endpoint called: transcription_id={transcription_id}")
        
        # Check if user is admin
        _, is_admin = get_user_from_request()
        if not is_admin:
            print("❌ Admin access denied")
            return jsonify({
                'success': False,
                'error': 'Admin access required'
            }), 403
        
        data = request.get_json()
        if not data or 'assigned_user_id' not in data:
            return jsonify({
                'success': False,
                'error': 'assigned_user_id is required'
            }), 400
        
        assigned_user_id = data['assigned_user_id']
        print(f"📝 Assigning to user: {assigned_user_id}")
        
        # Verify user exists
        if users_collection:
            from bson import ObjectId
            from bson.errors import InvalidId
            
            # Try to find user by ObjectId first
            try:
                user_obj_id = ObjectId(assigned_user_id)
                user = users_collection.find_one({'_id': user_obj_id})
            except (InvalidId, ValueError):
                user = None
            
            # If not found by ObjectId, try by username
            if not user:
                user = users_collection.find_one({'username': assigned_user_id})
            
            if not user:
                print(f"❌ User not found: {assigned_user_id}")
                return jsonify({
                    'success': False,
                    'error': 'User not found'
                }), 404
            
            assigned_user_id = str(user['_id'])
            print(f"✅ Found user: {assigned_user_id}")
        
        result = storage_manager.assign_transcription(transcription_id, assigned_user_id)
        
        if result['success']:
            assigned_id = result.get('assigned_user_id')
            print(f"✅ Successfully assigned transcription {transcription_id} to user {assigned_id}")
            
            # Verify the assignment in the database
            from bson import ObjectId
            try:
                doc = storage_manager.collection.find_one({'_id': ObjectId(transcription_id)})
                if doc:
                    saved_assigned = doc.get('assigned_user_id')
                    print(f"   Database verification: assigned_user_id = {saved_assigned}")
                    if str(saved_assigned) != str(assigned_id):
                        print(f"   ⚠️  Warning: Mismatch! Expected {assigned_id}, found {saved_assigned}")
            except Exception as verify_error:
                print(f"   ⚠️  Could not verify assignment: {verify_error}")
            
            return jsonify({
                'success': True,
                'message': result.get('message', 'Transcription assigned successfully'),
                'document_id': result.get('document_id'),
                'assigned_user_id': assigned_id
            })
        else:
            print(f"❌ Failed to assign: {result.get('error')}")
            return jsonify({
                'success': False,
                'error': result.get('error', 'Failed to assign transcription')
            }), 500
    
    except Exception as e:
        error_trace = traceback.format_exc()
        print(f"❌ Error assigning transcription: {str(e)}")
        print(error_trace)
        
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/admin/transcriptions/<transcription_id>/unassign', methods=['POST'])
def unassign_transcription(transcription_id):
    """
    Unassign a transcription (admin only).
    
    Headers:
        - X-Is-Admin: 'true' (required)
    """
    try:
        print(f"📝 Unassign transcription endpoint called: transcription_id={transcription_id}")
        
        # Check if user is admin
        _, is_admin = get_user_from_request()
        if not is_admin:
            return jsonify({
                'success': False,
                'error': 'Admin access required'
            }), 403
        
        result = storage_manager.unassign_transcription(transcription_id)
        
        if result['success']:
            print(f"✅ Successfully unassigned transcription {transcription_id}")
            return jsonify({
                'success': True,
                'message': result.get('message', 'Transcription unassigned successfully'),
                'document_id': result.get('document_id')
            })
        else:
            print(f"❌ Failed to unassign: {result.get('error')}")
            return jsonify({
                'success': False,
                'error': result.get('error', 'Failed to unassign transcription')
            }), 500
    
    except Exception as e:
        error_trace = traceback.format_exc()
        print(f"❌ Error unassigning transcription: {str(e)}")
        print(error_trace)
        
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/transcriptions/<transcription_id>', methods=['DELETE'])
def delete_transcription_by_id(transcription_id):
    """
    Delete a transcription from MongoDB (admin only).
    
    Headers:
        - X-Is-Admin: 'true' (required)
    """
    try:
        # Check if user is admin
        _, is_admin = get_user_from_request()
        if not is_admin:
            return jsonify({
                'success': False,
                'error': 'Admin access required'
            }), 403
        
        result = storage_manager.delete_transcription(transcription_id)
        
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


@app.route('/api/admin/users', methods=['GET'])
def list_users():
    """
    List all users (admin only).
    
    Headers:
        - X-Is-Admin: 'true' (required)
    """
    try:
        # Check if user is admin
        _, is_admin = get_user_from_request()
        if not is_admin:
            return jsonify({
                'success': False,
                'error': 'Admin access required'
            }), 403
        
        if not users_collection:
            return jsonify({
                'success': False,
                'error': 'User service unavailable'
            }), 500
        
        users = []
        for user in users_collection.find({}, {'password_hash': 0}):  # Exclude password
            user['_id'] = str(user['_id'])
            if 'created_at' in user and isinstance(user['created_at'], datetime):
                user['created_at'] = user['created_at'].isoformat()
            if 'updated_at' in user and isinstance(user['updated_at'], datetime):
                user['updated_at'] = user['updated_at'].isoformat()
            if 'last_login' in user and isinstance(user['last_login'], datetime):
                user['last_login'] = user['last_login'].isoformat()
            users.append(user)
        
        return jsonify({
            'success': True,
            'users': users
        })
    
    except Exception as e:
        error_trace = traceback.format_exc()
        print(f"❌ Error listing users: {str(e)}")
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
    print("   POST /api/auth/login                  - User login (username/password)")
    print("   POST /api/auth/register               - User registration")
    print("   GET  /api/languages                   - Get supported languages")
    print("   POST /api/transcribe                  - Transcribe audio (word-level)")
    print("   POST /api/transcribe/phrases          - Transcribe audio (phrase-level with emotions)")
    print("   GET  /api/audio/<filename>            - Serve audio file")
    print("   GET  /api/audio/s3-proxy              - Proxy S3 audio (CORS fix)")
    print("   GET  /api/transcription/<filename>    - Get transcription")
    print("   POST /api/transcription/save          - Save edited transcription")
    print("   POST /api/transcription/save-to-database - Save to S3 and MongoDB")
    print("   GET  /api/transcription/download/<f>  - Download transcription")
    print("   GET  /api/transcriptions              - List saved transcriptions (filtered by user)")
    print("   GET  /api/transcriptions/<id>         - Get transcription by ID (access controlled)")
    print("   PUT  /api/transcriptions/<id>         - Update transcription by ID")
    print("   DELETE /api/transcriptions/<id>       - Delete transcription by ID (admin only)")
    print("   POST /api/admin/transcriptions/<id>/assign - Assign transcription to user (admin)")
    print("   POST /api/admin/transcriptions/<id>/unassign - Unassign transcription (admin)")
    print("   GET  /api/admin/users                - List all users (admin)")
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


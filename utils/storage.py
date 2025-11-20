"""
Storage utilities for S3 and MongoDB operations.
"""
import os
import boto3
from pymongo import MongoClient
from datetime import datetime, timezone
from typing import Dict, Any, Optional
from botocore.exceptions import ClientError
import json


class StorageManager:
    """Manages S3 and MongoDB storage operations."""
    
    def __init__(self):
        """Initialize S3 and MongoDB connections."""
        # S3 Configuration - support both AWS_ACCESS_KEY_ID and ACCESS_KEY_ID
        self.s3_bucket_name = os.getenv('S3_BUCKET_NAME', 'transcription-audio-files')
        self.s3_region = os.getenv('S3_REGION', 'us-east-1')
        self.aws_access_key_id = os.getenv('AWS_ACCESS_KEY_ID') or os.getenv('ACCESS_KEY_ID')
        self.aws_secret_access_key = os.getenv('AWS_SECRET_ACCESS_KEY') or os.getenv('SECRET_ACCESS_KEY')
        
        # MongoDB Configuration
        self.mongodb_uri = os.getenv('MONGODB_URI', 'mongodb://localhost:27017/')
        self.mongodb_database = os.getenv('MONGODB_DATABASE', 'transcription_db')
        self.mongodb_collection = os.getenv('MONGODB_COLLECTION', 'transcriptions')
        
        # Initialize S3 client
        try:
            if self.aws_access_key_id and self.aws_secret_access_key:
                self.s3_client = boto3.client(
                    's3',
                    region_name=self.s3_region,
                    aws_access_key_id=self.aws_access_key_id,
                    aws_secret_access_key=self.aws_secret_access_key
                )
                print(f"✅ S3 client initialized with credentials")
                print(f"   Bucket: {self.s3_bucket_name}, Region: {self.s3_region}")
            else:
                # Use default credentials (IAM role, environment, or ~/.aws/credentials)
                self.s3_client = boto3.client('s3', region_name=self.s3_region)
                print(f"✅ S3 client initialized with default credentials")
                print(f"   Bucket: {self.s3_bucket_name}, Region: {self.s3_region}")
        except Exception as e:
            print(f"❌ Warning: Could not initialize S3 client: {str(e)}")
            self.s3_client = None
        
        # Initialize MongoDB client
        try:
            self.mongo_client = MongoClient(self.mongodb_uri)
            self.db = self.mongo_client[self.mongodb_database]
            
            # Test connection with ping first
            self.mongo_client.admin.command('ping')
            
            # List existing collections
            collections = self.db.list_collection_names()
            
            # Get collection (MongoDB creates it automatically on first insert)
            self.collection = self.db[self.mongodb_collection]
            
            # Create indexes for better query performance
            try:
                self.collection.create_index('created_at')
                self.collection.create_index('user_id')
                self.collection.create_index([('user_id', 1), ('created_at', -1)])  # Compound index
                print(f"✅ Created indexes on 'created_at' and 'user_id' fields")
            except Exception as e:
                # Index might already exist, which is fine
                pass
            
            print(f"✅ Connected to MongoDB: {self.mongodb_database}")
            print(f"   Collection: {self.mongodb_collection}")
            print(f"   Existing collections: {collections if collections else 'None (will be created on first insert)'}")
            
        except Exception as e:
            print(f"❌ Warning: Could not connect to MongoDB: {str(e)}")
            self.mongo_client = None
            self.db = None
            self.collection = None
    
    def _get_content_type(self, file_path: str) -> str:
        """Get content type based on file extension."""
        extension = os.path.splitext(file_path)[1].lower()
        content_types = {
            '.mp3': 'audio/mpeg',
            '.wav': 'audio/wav',
            '.m4a': 'audio/mp4',
            '.ogg': 'audio/ogg',
            '.flac': 'audio/flac',
            '.aac': 'audio/aac',
        }
        return content_types.get(extension, 'audio/mpeg')
    
    def delete_audio_from_s3(self, s3_key: str) -> Dict[str, Any]:
        """
        Delete audio file from S3 bucket.
        
        Args:
            s3_key: S3 object key (path in bucket)
            
        Returns:
            Dictionary with deletion result
        """
        try:
            if not self.s3_client:
                return {
                    'success': False,
                    'error': 'S3 client not initialized. Please check AWS credentials.'
                }
            
            # Delete object from S3
            self.s3_client.delete_object(
                Bucket=self.s3_bucket_name,
                Key=s3_key
            )
            
            print(f"✅ Deleted S3 object: {s3_key}")
            
            return {
                'success': True,
                'message': f'S3 object deleted successfully: {s3_key}'
            }
            
        except ClientError as e:
            error_code = e.response.get('Error', {}).get('Code', 'Unknown')
            if error_code == 'NoSuchKey':
                # Object doesn't exist, but that's okay - consider it deleted
                print(f"⚠️ S3 object not found (may already be deleted): {s3_key}")
                return {
                    'success': True,
                    'message': f'S3 object not found (may already be deleted): {s3_key}'
                }
            return {
                'success': False,
                'error': f"S3 deletion error: {str(e)}"
            }
        except Exception as e:
            return {
                'success': False,
                'error': f"Unexpected error during S3 deletion: {str(e)}"
            }
    
    def upload_audio_to_s3(self, local_file_path: str, s3_key: str) -> Dict[str, Any]:
        """
        Upload audio file to S3 bucket.
        
        Args:
            local_file_path: Path to local audio file
            s3_key: S3 object key (path in bucket)
            
        Returns:
            Dictionary with S3 metadata including URL, bucket, key, etc.
        """
        try:
            if not self.s3_client:
                return {
                    'success': False,
                    'error': 'S3 client not initialized. Please check AWS credentials.'
                }
            
            # Get file size
            file_size = os.path.getsize(local_file_path)
            
            # Get content type based on file extension
            content_type = self._get_content_type(local_file_path)
            
            # Upload file to S3
            self.s3_client.upload_file(
                local_file_path,
                self.s3_bucket_name,
                s3_key,
                ExtraArgs={'ContentType': content_type}
            )
            
            # Generate S3 URL
            s3_url = f"https://{self.s3_bucket_name}.s3.{self.s3_region}.amazonaws.com/{s3_key}"
            
            # Get object metadata
            s3_metadata = {
                'bucket': self.s3_bucket_name,
                'key': s3_key,
                'url': s3_url,
                'region': self.s3_region,
                'size_bytes': file_size,
                'uploaded_at': datetime.now(timezone.utc).isoformat()
            }
            
            return {
                'success': True,
                'metadata': s3_metadata
            }
            
        except ClientError as e:
            return {
                'success': False,
                'error': f"S3 upload error: {str(e)}"
            }
        except Exception as e:
            return {
                'success': False,
                'error': f"Unexpected error during S3 upload: {str(e)}"
            }
    
    def save_to_mongodb(self, transcription_data: Dict[str, Any], s3_metadata: Dict[str, Any], user_id: Optional[str] = None) -> Dict[str, Any]:
        """
        Save transcription data and S3 metadata to MongoDB.
        User ID is optional - if not provided, defaults to 'anonymous'.
        
        Args:
            transcription_data: Transcription JSON data
            s3_metadata: S3 metadata from upload
            user_id: User ID to associate with this transcription (optional, defaults to 'anonymous')
            
        Returns:
            Dictionary with MongoDB operation result
        """
        try:
            if not self.collection:
                return {
                    'success': False,
                    'error': 'MongoDB not initialized. Please check MongoDB connection.'
                }
            
            # Use 'anonymous' if user_id is not provided
            if not user_id:
                user_id = 'anonymous'
            
            # Prepare document
            # assigned_user_id is None by default - admin will assign it later
            document = {
                'transcription_data': transcription_data,
                's3_metadata': s3_metadata,
                'user_id': user_id,  # Creator/owner of the transcription
                'assigned_user_id': None,  # Assigned to a specific user (managed by admin)
                'created_at': datetime.now(timezone.utc),
                'updated_at': datetime.now(timezone.utc)
            }
            
            # Insert document (MongoDB will create collection automatically if it doesn't exist)
            result = self.collection.insert_one(document)
            
            print(f"✅ Document saved to MongoDB collection '{self.mongodb_collection}'")
            print(f"   Document ID: {result.inserted_id}")
            
            return {
                'success': True,
                'document_id': str(result.inserted_id),
                'message': 'Data saved to MongoDB successfully'
            }
            
        except Exception as e:
            return {
                'success': False,
                'error': f"MongoDB save error: {str(e)}"
            }
    
    def save_transcription(self, local_audio_path: str, transcription_data: Dict[str, Any], 
                          original_filename: str, user_id: Optional[str] = None) -> Dict[str, Any]:
        """
        Complete save operation: upload audio to S3 and save transcription to MongoDB.
        User ID is optional - if not provided, defaults to 'anonymous'.
        
        Args:
            local_audio_path: Path to local audio file
            transcription_data: Transcription JSON data
            original_filename: Original audio filename
            user_id: User ID to associate with this transcription (optional, defaults to 'anonymous')
            
        Returns:
            Dictionary with complete operation result
        """
        try:
            # Use 'anonymous' if user_id is not provided
            if not user_id:
                user_id = 'anonymous'
            
            # Generate S3 key (path in bucket)
            timestamp = datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')
            file_extension = os.path.splitext(original_filename)[1]
            s3_key = f"audio/{timestamp}_{original_filename}"
            
            # Upload to S3
            s3_result = self.upload_audio_to_s3(local_audio_path, s3_key)
            
            if not s3_result['success']:
                return s3_result
            
            s3_metadata = s3_result['metadata']
            
            # Save to MongoDB
            mongo_result = self.save_to_mongodb(transcription_data, s3_metadata, user_id)
            
            if not mongo_result['success']:
                return mongo_result
            
            return {
                'success': True,
                's3_metadata': s3_metadata,
                'mongodb_id': mongo_result['document_id'],
                'message': 'Audio and transcription saved successfully'
            }
            
        except Exception as e:
            return {
                'success': False,
                'error': f"Save operation error: {str(e)}"
            }
    
    def get_transcription(self, document_id: str, user_id: Optional[str] = None, is_admin: bool = False) -> Optional[Dict[str, Any]]:
        """
        Retrieve transcription from MongoDB by document ID.
        Regular users can only access transcriptions assigned to them.
        Admins can access all transcriptions.
        
        Args:
            document_id: MongoDB document ID
            user_id: User ID to check access (if not admin)
            is_admin: Whether the user is an admin
            
        Returns:
            Document data or None if not found or access denied
        """
        try:
            if not self.collection:
                return None
                
            from bson import ObjectId
            from bson.errors import InvalidId
            
            # Validate ObjectId format
            try:
                obj_id = ObjectId(document_id)
            except (InvalidId, ValueError) as e:
                print(f"❌ Invalid transcription ID format: {document_id}")
                return None
            
            # Get document by ID
            document = self.collection.find_one({'_id': obj_id})
            
            if not document:
                return None
            
            # Check access: admins can see all, regular users only assigned ones
            if not is_admin and user_id:
                assigned_user_id = document.get('assigned_user_id')
                # If assigned_user_id doesn't exist (old data), deny access
                # If assigned_user_id exists but doesn't match, deny access
                if assigned_user_id is None or str(assigned_user_id) != str(user_id):
                    # User doesn't have access to this transcription
                    print(f"🚫 Access denied: user {user_id} trying to access transcription assigned to {assigned_user_id}")
                    return None
            
            # Convert ObjectId to string for JSON serialization (for all cases)
            document['_id'] = str(document['_id'])
            # Convert datetime to ISO format (for all cases)
            if 'created_at' in document and isinstance(document['created_at'], datetime):
                document['created_at'] = document['created_at'].isoformat()
            if 'updated_at' in document and isinstance(document['updated_at'], datetime):
                document['updated_at'] = document['updated_at'].isoformat()
            
            return document
        except Exception as e:
            print(f"❌ Error retrieving transcription: {str(e)}")
            import traceback
            print(traceback.format_exc())
            return None
    
    def assign_transcription(self, document_id: str, assigned_user_id: str) -> Dict[str, Any]:
        """
        Assign a transcription to a specific user (admin only operation).
        
        Args:
            document_id: MongoDB document ID
            assigned_user_id: User ID to assign the transcription to
            
        Returns:
            Dictionary with assignment result
        """
        try:
            if not self.collection:
                return {
                    'success': False,
                    'error': 'MongoDB not initialized'
                }
            
            from bson import ObjectId
            from bson.errors import InvalidId
            
            # Validate and convert ObjectId
            try:
                obj_id = ObjectId(document_id)
            except (InvalidId, ValueError) as e:
                return {
                    'success': False,
                    'error': f'Invalid transcription ID format: {str(e)}'
                }
            
            # Ensure assigned_user_id is stored as string for consistent filtering
            assigned_user_id_str = str(assigned_user_id)
            
            # Update the assigned_user_id field
            update_result = self.collection.update_one(
                {'_id': obj_id},
                {
                    '$set': {
                        'assigned_user_id': assigned_user_id_str,
                        'updated_at': datetime.now(timezone.utc)
                    }
                }
            )
            
            if update_result.matched_count == 0:
                return {
                    'success': False,
                    'error': 'Transcription not found'
                }
            
            # Verify the assignment was saved correctly
            updated_doc = self.collection.find_one({'_id': obj_id})
            saved_assigned_id = updated_doc.get('assigned_user_id') if updated_doc else None
            
            print(f"✅ Assigned transcription {document_id} to user {assigned_user_id_str}")
            print(f"   Verification: saved assigned_user_id = {saved_assigned_id}")
            
            if str(saved_assigned_id) != assigned_user_id_str:
                print(f"⚠️  Warning: Assignment mismatch! Expected {assigned_user_id_str}, got {saved_assigned_id}")
            
            return {
                'success': True,
                'document_id': document_id,
                'assigned_user_id': assigned_user_id_str,  # Return the string version for consistency
                'message': 'Transcription assigned successfully'
            }
            
        except Exception as e:
            return {
                'success': False,
                'error': f"Error assigning transcription: {str(e)}"
            }
    
    def unassign_transcription(self, document_id: str) -> Dict[str, Any]:
        """
        Unassign a transcription (set assigned_user_id to None).
        
        Args:
            document_id: MongoDB document ID
            
        Returns:
            Dictionary with unassignment result
        """
        try:
            if not self.collection:
                return {
                    'success': False,
                    'error': 'MongoDB not initialized'
                }
            
            from bson import ObjectId
            from bson.errors import InvalidId
            
            # Validate and convert ObjectId
            try:
                obj_id = ObjectId(document_id)
            except (InvalidId, ValueError) as e:
                return {
                    'success': False,
                    'error': f'Invalid transcription ID format: {str(e)}'
                }
            
            # Remove the assigned_user_id (set to None)
            update_result = self.collection.update_one(
                {'_id': obj_id},
                {
                    '$set': {
                        'assigned_user_id': None,
                        'updated_at': datetime.now(timezone.utc)
                    }
                }
            )
            
            if update_result.matched_count == 0:
                return {
                    'success': False,
                    'error': 'Transcription not found'
                }
            
            print(f"✅ Unassigned transcription {document_id}")
            
            return {
                'success': True,
                'document_id': document_id,
                'message': 'Transcription unassigned successfully'
            }
            
        except Exception as e:
            return {
                'success': False,
                'error': f"Error unassigning transcription: {str(e)}"
            }
    
    def list_transcriptions(self, limit: int = 100, skip: int = 0, user_id: Optional[str] = None, is_admin: bool = False) -> Dict[str, Any]:
        """
        List transcriptions from MongoDB.
        Regular users can only see transcriptions assigned to them.
        Admins can see all transcriptions.
        
        Args:
            limit: Maximum number of documents to return
            skip: Number of documents to skip
            user_id: User ID to filter transcriptions (if not admin)
            is_admin: Whether the user is an admin (admins see all transcriptions)
            
        Returns:
            Dictionary with list of transcriptions and metadata
        """
        try:
            if not self.collection:
                return {
                    'success': False,
                    'error': 'MongoDB not initialized'
                }
            
            # Build query filter
            # Admins see all transcriptions, regular users only see assigned ones
            if is_admin:
                query_filter = {}
                print(f"👑 Admin user - showing all transcriptions")
            else:
                if user_id:
                    # Regular users see transcriptions assigned to them
                    # Ensure user_id is a string for comparison (MongoDB stores assigned_user_id as string)
                    user_id_str = str(user_id)
                    # Match documents where assigned_user_id equals user_id
                    # This will only match documents that have assigned_user_id field set to this user
                    query_filter = {'assigned_user_id': user_id_str}
                    print(f"🔍 Filtering transcriptions for user: {user_id_str} (is_admin: {is_admin})")
                else:
                    # If no user_id provided and not admin, return empty
                    # Match unassigned transcriptions (assigned_user_id is None or doesn't exist)
                    query_filter = {
                        '$or': [
                            {'assigned_user_id': None},
                            {'assigned_user_id': {'$exists': False}}
                        ]
                    }
                    print("⚠️  No user_id provided for non-admin user, showing unassigned only")
            
            # Get total count
            total_count = self.collection.count_documents(query_filter)
            print(f"📊 Query filter: {query_filter}, Total count: {total_count}")
            
            # Get documents sorted by created_at descending (newest first)
            cursor = self.collection.find(query_filter).sort('created_at', -1).skip(skip).limit(limit)
            
            transcriptions = []
            for doc in cursor:
                # Convert ObjectId to string
                doc['_id'] = str(doc['_id'])
                # Convert datetime to ISO format
                if 'created_at' in doc:
                    doc['created_at'] = doc['created_at'].isoformat()
                if 'updated_at' in doc:
                    doc['updated_at'] = doc['updated_at'].isoformat()
                
                # Extract summary info
                transcription_data = doc.get('transcription_data', {})
                s3_metadata = doc.get('s3_metadata', {})
                metadata = transcription_data.get('metadata', {})
                
                # Priority order for filename:
                # 1. audio_path from metadata.audio_path or transcription_data.audio_path
                # 2. S3 key (contains timestamped filename like "audio/20250120_123456_audio.mp3")
                # 3. metadata.filename (fallback)
                display_filename = ''
                
                # Check audio_path in both locations
                audio_path = transcription_data.get('audio_path') or metadata.get('audio_path', '')
                
                if audio_path:
                    # Extract filename from audio_path (handle paths like "/api/audio/5143282_audio.mp3" or "5143282_audio.mp3")
                    if '/' in audio_path:
                        display_filename = audio_path.split('/')[-1]
                    else:
                        display_filename = audio_path
                elif s3_metadata.get('key'):
                    # Use S3 key which contains timestamped filename (e.g., "audio/20250120_123456_audio.mp3")
                    s3_key = s3_metadata.get('key', '')
                    display_filename = s3_key.split('/')[-1] if '/' in s3_key else s3_key
                else:
                    # Fallback to metadata filename
                    display_filename = metadata.get('filename', '')
                
                summary = {
                    '_id': doc['_id'],
                    'created_at': doc.get('created_at'),
                    'updated_at': doc.get('updated_at'),
                    'transcription_type': transcription_data.get('transcription_type', 'words'),
                    'language': transcription_data.get('language', 'Unknown'),
                    'total_words': transcription_data.get('total_words', 0),
                    'total_phrases': transcription_data.get('total_phrases', 0),
                    'audio_duration': transcription_data.get('audio_duration', 0),
                    's3_url': s3_metadata.get('url', ''),
                    'filename': display_filename,
                    'user_id': doc.get('user_id'),  # Creator
                    'assigned_user_id': doc.get('assigned_user_id')  # Assigned user
                }
                transcriptions.append(summary)
            
            return {
                'success': True,
                'transcriptions': transcriptions,
                'total': total_count,
                'limit': limit,
                'skip': skip
            }
            
        except Exception as e:
            return {
                'success': False,
                'error': f"Error listing transcriptions: {str(e)}"
            }
    
    def update_transcription(self, document_id: str, transcription_data: Dict[str, Any], user_id: Optional[str] = None) -> Dict[str, Any]:
        """
        Update transcription data in MongoDB (all users can update all data).
        
        Args:
            document_id: MongoDB document ID
            transcription_data: Updated transcription data
            user_id: Ignored (kept for backward compatibility)
            
        Returns:
            Dictionary with update result
        """
        try:
            if not self.collection:
                return {
                    'success': False,
                    'error': 'MongoDB not initialized'
                }
            
            from bson import ObjectId
            
            # Update document by ID only (no user_id filtering)
            update_result = self.collection.update_one(
                {'_id': ObjectId(document_id)},
                {
                    '$set': {
                        'transcription_data': transcription_data,
                        'updated_at': datetime.now(timezone.utc)
                    }
                }
            )
            
            if update_result.matched_count == 0:
                return {
                    'success': False,
                    'error': 'Transcription not found'
                }
            
            print(f"✅ Updated transcription in MongoDB: {document_id}")
            
            return {
                'success': True,
                'document_id': document_id,
                'message': 'Transcription updated successfully'
            }
            
        except Exception as e:
            return {
                'success': False,
                'error': f"Error updating transcription: {str(e)}"
            }
    
    def delete_transcription(self, document_id: str, user_id: Optional[str] = None) -> Dict[str, Any]:
        """
        Delete a transcription from MongoDB and its associated S3 audio file (all users can delete all data).
        
        Args:
            document_id: MongoDB document ID
            user_id: Ignored (kept for backward compatibility)
            
        Returns:
            Dictionary with delete operation result
        """
        try:
            if not self.collection:
                return {
                    'success': False,
                    'error': 'MongoDB not initialized'
                }
            
            from bson import ObjectId
            
            # Get the document to extract S3 metadata before deleting (no user_id filtering)
            document = self.collection.find_one({'_id': ObjectId(document_id)})
            
            if not document:
                return {
                    'success': False,
                    'error': 'Transcription not found'
                }
            
            # Extract S3 key from document
            s3_metadata = document.get('s3_metadata', {})
            s3_key = s3_metadata.get('key', '')
            
            # Delete S3 object if key exists
            s3_delete_result = None
            if s3_key:
                print(f"🗑️  Attempting to delete S3 object: {s3_key}")
                s3_delete_result = self.delete_audio_from_s3(s3_key)
                if not s3_delete_result.get('success'):
                    # Log warning but continue with MongoDB deletion
                    print(f"⚠️  Warning: Failed to delete S3 object: {s3_delete_result.get('error')}")
            else:
                print(f"⚠️  No S3 key found in document, skipping S3 deletion")
            
            # Delete document from MongoDB (no user_id filtering)
            delete_result = self.collection.delete_one({'_id': ObjectId(document_id)})
            
            if delete_result.deleted_count == 0:
                return {
                    'success': False,
                    'error': 'Transcription not found in MongoDB'
                }
            
            print(f"✅ Deleted transcription from MongoDB: {document_id}")
            
            # Prepare response message
            message = 'Transcription deleted successfully'
            if s3_key:
                if s3_delete_result and s3_delete_result.get('success'):
                    message += f'. S3 audio file ({s3_key}) also deleted.'
                else:
                    message += f'. Note: S3 audio file deletion had issues (check logs).'
            
            return {
                'success': True,
                'document_id': document_id,
                'message': message,
                's3_deleted': s3_delete_result.get('success') if s3_delete_result else False
            }
            
        except Exception as e:
            return {
                'success': False,
                'error': f"Error deleting transcription: {str(e)}"
            }


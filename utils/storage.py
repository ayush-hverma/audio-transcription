"""
Storage utilities for S3 and MongoDB operations.
"""
import os
import boto3
from pymongo import MongoClient
from datetime import datetime
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
            
            # Create index on created_at for better query performance
            try:
                self.collection.create_index('created_at')
                print(f"✅ Created index on 'created_at' field")
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
                'uploaded_at': datetime.utcnow().isoformat()
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
    
    def save_to_mongodb(self, transcription_data: Dict[str, Any], s3_metadata: Dict[str, Any]) -> Dict[str, Any]:
        """
        Save transcription data and S3 metadata to MongoDB.
        
        Args:
            transcription_data: Transcription JSON data
            s3_metadata: S3 metadata from upload
            
        Returns:
            Dictionary with MongoDB operation result
        """
        try:
            if not self.collection:
                return {
                    'success': False,
                    'error': 'MongoDB not initialized. Please check MongoDB connection.'
                }
            
            # Prepare document
            document = {
                'transcription_data': transcription_data,
                's3_metadata': s3_metadata,
                'created_at': datetime.utcnow(),
                'updated_at': datetime.utcnow()
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
                          original_filename: str) -> Dict[str, Any]:
        """
        Complete save operation: upload audio to S3 and save transcription to MongoDB.
        
        Args:
            local_audio_path: Path to local audio file
            transcription_data: Transcription JSON data
            original_filename: Original audio filename
            
        Returns:
            Dictionary with complete operation result
        """
        try:
            # Generate S3 key (path in bucket)
            timestamp = datetime.utcnow().strftime('%Y%m%d_%H%M%S')
            file_extension = os.path.splitext(original_filename)[1]
            s3_key = f"audio/{timestamp}_{original_filename}"
            
            # Upload to S3
            s3_result = self.upload_audio_to_s3(local_audio_path, s3_key)
            
            if not s3_result['success']:
                return s3_result
            
            s3_metadata = s3_result['metadata']
            
            # Save to MongoDB
            mongo_result = self.save_to_mongodb(transcription_data, s3_metadata)
            
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
    
    def get_transcription(self, document_id: str) -> Optional[Dict[str, Any]]:
        """
        Retrieve transcription from MongoDB by document ID.
        
        Args:
            document_id: MongoDB document ID
            
        Returns:
            Document data or None if not found
        """
        try:
            if not self.collection:
                return None
                
            from bson import ObjectId
            document = self.collection.find_one({'_id': ObjectId(document_id)})
            if document:
                # Convert ObjectId to string for JSON serialization
                document['_id'] = str(document['_id'])
                # Convert datetime to ISO format
                if 'created_at' in document:
                    document['created_at'] = document['created_at'].isoformat()
                if 'updated_at' in document:
                    document['updated_at'] = document['updated_at'].isoformat()
            return document
        except Exception as e:
            print(f"Error retrieving transcription: {str(e)}")
            return None
    
    def list_transcriptions(self, limit: int = 100, skip: int = 0) -> Dict[str, Any]:
        """
        List all transcriptions from MongoDB.
        
        Args:
            limit: Maximum number of documents to return
            skip: Number of documents to skip
            
        Returns:
            Dictionary with list of transcriptions and metadata
        """
        try:
            if not self.collection:
                return {
                    'success': False,
                    'error': 'MongoDB not initialized'
                }
            
            # Get total count
            total_count = self.collection.count_documents({})
            
            # Get documents sorted by created_at descending (newest first)
            cursor = self.collection.find().sort('created_at', -1).skip(skip).limit(limit)
            
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
                    'filename': s3_metadata.get('key', '').split('/')[-1] if s3_metadata.get('key') else ''
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
    
    def update_transcription(self, document_id: str, transcription_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Update transcription data in MongoDB.
        
        Args:
            document_id: MongoDB document ID
            transcription_data: Updated transcription data
            
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
            
            # Update document, preserving s3_metadata and timestamps
            update_result = self.collection.update_one(
                {'_id': ObjectId(document_id)},
                {
                    '$set': {
                        'transcription_data': transcription_data,
                        'updated_at': datetime.utcnow()
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
    
    def delete_transcription(self, document_id: str) -> Dict[str, Any]:
        """
        Delete a transcription from MongoDB and its associated S3 audio file.
        
        Args:
            document_id: MongoDB document ID
            
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
            
            # First, get the document to extract S3 metadata before deleting
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
            
            # Delete document from MongoDB
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


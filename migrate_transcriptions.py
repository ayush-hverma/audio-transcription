"""
Migration script to update existing transcription documents to include assigned_user_id field.
This ensures all transcriptions have the assigned_user_id field (set to None if not assigned).
"""
import sys
from pathlib import Path
from pymongo import MongoClient
from datetime import datetime, timezone
from dotenv import load_dotenv
import os

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent))

# Load environment variables
backend_dir = Path(__file__).parent / 'backend'
env_path = backend_dir / '.env'
load_dotenv(dotenv_path=env_path)

# MongoDB Configuration
MONGODB_URI = os.getenv('MONGODB_URI', 'mongodb://localhost:27017/')
MONGODB_DATABASE = os.getenv('MONGODB_DATABASE', 'transcription_db')
MONGODB_COLLECTION = os.getenv('MONGODB_COLLECTION', 'transcriptions')


def migrate_transcriptions():
    """Add assigned_user_id field to existing transcriptions that don't have it."""
    try:
        # Connect to MongoDB
        client = MongoClient(MONGODB_URI)
        db = client[MONGODB_DATABASE]
        collection = db[MONGODB_COLLECTION]
        
        # Test connection
        client.admin.command('ping')
        print(f"✅ Connected to MongoDB: {MONGODB_DATABASE}")
        print(f"   Collection: {MONGODB_COLLECTION}")
        
        # Find all documents that don't have assigned_user_id field
        query = {'assigned_user_id': {'$exists': False}}
        documents_to_update = collection.find(query)
        
        count = collection.count_documents(query)
        print(f"\n📊 Found {count} transcription(s) without 'assigned_user_id' field")
        
        if count == 0:
            print("✅ All transcriptions already have 'assigned_user_id' field. No migration needed.")
            client.close()
            return
        
        # Update all documents to add assigned_user_id: None
        update_result = collection.update_many(
            query,
            {
                '$set': {
                    'assigned_user_id': None,
                    'updated_at': datetime.now(timezone.utc)
                }
            }
        )
        
        print(f"\n✅ Migration completed:")
        print(f"   Updated: {update_result.modified_count} transcription(s)")
        print(f"   Matched: {update_result.matched_count} transcription(s)")
        
        # Verify the update
        remaining = collection.count_documents({'assigned_user_id': {'$exists': False}})
        if remaining == 0:
            print(f"✅ Verification: All transcriptions now have 'assigned_user_id' field")
        else:
            print(f"⚠️  Warning: {remaining} transcription(s) still missing 'assigned_user_id' field")
        
        client.close()
        
    except Exception as e:
        print(f"❌ Error during migration: {str(e)}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == '__main__':
    print("="*60)
    print("Migration: Add assigned_user_id to Existing Transcriptions")
    print("="*60)
    print()
    migrate_transcriptions()
    print("\n" + "="*60)


"""
Script to create four user accounts in MongoDB users collection.
Run this script once to initialize the user accounts.
"""
import sys
from pathlib import Path
import bcrypt
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

# Define four users
USERS = [
    {
        'username': 'user1',
        'password': 'password1',
        'email': 'user1@example.com',
        'name': 'User One',
        'is_admin': False
    },
    {
        'username': 'user2',
        'password': 'password2',
        'email': 'user2@example.com',
        'name': 'User Two',
        'is_admin': False
    },
    {
        'username': 'user3',
        'password': 'password3',
        'email': 'user3@example.com',
        'name': 'User Three',
        'is_admin': False
    },
    {
        'username': 'user4',
        'password': 'password4',
        'email': 'user4@example.com',
        'name': 'User Four',
        'is_admin': False
    },
    {
        'username': 'admin',
        'password': 'admin123',
        'email': 'admin@example.com',
        'name': 'Administrator',
        'is_admin': True
    }
]


def hash_password(password: str) -> str:
    """Hash a password using bcrypt."""
    salt = bcrypt.gensalt()
    hashed = bcrypt.hashpw(password.encode('utf-8'), salt)
    return hashed.decode('utf-8')


def create_users():
    """Create user accounts in MongoDB."""
    try:
        # Connect to MongoDB
        client = MongoClient(MONGODB_URI)
        db = client[MONGODB_DATABASE]
        users_collection = db['users']
        
        # Test connection
        client.admin.command('ping')
        print(f"✅ Connected to MongoDB: {MONGODB_DATABASE}")
        
        # Check and handle existing indexes
        existing_indexes = users_collection.list_indexes()
        index_names = [idx['name'] for idx in existing_indexes]
        
        # Check if google_id index exists and is causing issues
        if 'google_id_1' in index_names:
            print("⚠️  Found existing 'google_id' unique index")
            # Drop the google_id index if it exists (we'll recreate it as sparse if needed)
            try:
                users_collection.drop_index('google_id_1')
                print("   Dropped existing 'google_id' index")
            except Exception as e:
                print(f"   Could not drop 'google_id' index: {e}")
        
        # Create index on username for uniqueness
        try:
            users_collection.create_index('username', unique=True)
            print("✅ Created unique index on 'username' field")
        except Exception as e:
            # Index might already exist
            if 'already exists' in str(e).lower() or 'E11000' not in str(e):
                print("✅ Username index already exists")
            else:
                raise
        
        # Create sparse unique index on google_id (only applies to non-null values)
        try:
            users_collection.create_index('google_id', unique=True, sparse=True)
            print("✅ Created sparse unique index on 'google_id' field")
        except Exception as e:
            # Index might already exist
            if 'already exists' in str(e).lower():
                print("✅ Google ID index already exists (sparse)")
            else:
                print(f"⚠️  Could not create google_id index: {e}")
        
        created_count = 0
        skipped_count = 0
        
        # Create each user
        for user_data in USERS:
            username = user_data['username']
            
            # Check if user already exists
            existing_user = users_collection.find_one({'username': username})
            
            if existing_user:
                print(f"⚠️  User '{username}' already exists, skipping...")
                skipped_count += 1
                continue
            
            # Hash password
            hashed_password = hash_password(user_data['password'])
            
            # Create user document
            # Note: We don't include 'google_id' field for username/password users
            # The sparse index on google_id allows multiple null values
            user_doc = {
                'username': username,
                'password_hash': hashed_password,
                'email': user_data['email'],
                'name': user_data['name'],
                'is_admin': user_data.get('is_admin', False),
                'created_at': datetime.now(timezone.utc),
                'updated_at': datetime.now(timezone.utc)
            }
            
            # Insert user
            result = users_collection.insert_one(user_doc)
            print(f"✅ Created user: {username} (ID: {result.inserted_id})")
            created_count += 1
        
        print("\n" + "="*60)
        print(f"Summary:")
        print(f"  Created: {created_count} users")
        print(f"  Skipped: {skipped_count} users (already exist)")
        print("="*60)
        
        # Print user credentials
        print("\nUser Credentials:")
        print("-" * 60)
        for user_data in USERS:
            print(f"  Username: {user_data['username']}")
            print(f"  Password: {user_data['password']}")
            print()
        
        client.close()
        
    except Exception as e:
        print(f"❌ Error creating users: {str(e)}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == '__main__':
    print("="*60)
    print("Creating User Accounts in MongoDB")
    print("="*60)
    print()
    create_users()


# aksker_config.py

# Din Google Gemini API Key
GEMINI_API_KEY = "AIzaSyDWI_ZMaorcX4z0ui1GhVe-zg4mt6nsFmc"

# SQL Database Config (flyttet hit for ryddighet)
DB_CONFIG = {
    "host": "localhost",
    "port": 5432,
    "dbname": "EI_Input data",
    "user": "postgres",
    "password": "I=theKingintheNorth!",
}



SUPABASE_CONFIG = {
    'user': 'postgres.scjwctfouvrpxmoapkhm',
    'password': 'I=theKingintheNorth!', # Erstatt med passordet du valgte for databasen
    'host': 'aws-0-eu-west-1.pooler.supabase.com',
    'port': '6543', 
    'dbname': 'postgres',
    'sslmode': 'require'
}
import pandas as pd
import psycopg2
from psycopg2.extras import execute_values
import aksker_config as cfg

csv_path = r"C:\Users\espen\Downloads\news_feed.csv"
print(f"Leser {csv_path}...")

df = pd.read_csv(csv_path)

# Vår tabell har ikke 'id'-kolonne, så vi ignorerer den
df = df.drop(columns=['id'], errors='ignore')

# Konverterer tomme verdier (NaN) til None for at databasen skal få NULL
df = df.where(pd.notnull(df), None)

records = []
for _, row in df.iterrows():
    records.append((
        row['ticker'],
        row['published_at'],
        row['title'],
        row['source'],
        row['url'],
        row['summary'],
        row['relevance_score']
    ))

query = """
    INSERT INTO news_feed (ticker, published_at, title, source, url, summary, relevance_score)
    VALUES %s
    ON CONFLICT (ticker, title) DO NOTHING;
"""

try:
    with psycopg2.connect(**cfg.SUPABASE_CONFIG) as conn:
        with conn.cursor() as cur:
            execute_values(cur, query, records)
    print(f"✅ Suksess! Importerte {len(records)} nyhetsartikler til Supabase.")
except Exception as e:
    print(f"❌ Feil under import: {e}")

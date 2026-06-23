import pandas as pd
import psycopg2
import math
import aksker_config as cfg

file_path = r'C:\Users\espen\Downloads\Company data exmapales.xlsx'

print("Connecting to Supabase...")
conn = psycopg2.connect(**cfg.SUPABASE_CONFIG)
cur = conn.cursor()

print("Reading Excel...")
df = pd.read_excel(file_path, sheet_name='Sheet1')

print("Creating table if not exists...")
cur.execute("""
    CREATE TABLE IF NOT EXISTS company_financial_data (
        id SERIAL PRIMARY KEY,
        selskap VARCHAR(255),
        gruppe VARCHAR(255),
        kategori VARCHAR(255),
        aar INTEGER,
        verdi DOUBLE PRECISION,
        merknad TEXT,
        UNIQUE(selskap, gruppe, kategori, aar)
    );
""")
conn.commit()

inserted = 0
for index, row in df.iterrows():
    selskap = str(row['Selskap']) if pd.notna(row['Selskap']) else None
    gruppe = str(row['Gruppe']) if pd.notna(row['Gruppe']) else None
    kategori = str(row['Kategori']) if pd.notna(row['Kategori']) else None
    
    aar = None
    if pd.notna(row['År']):
        try:
            aar = int(row['År'])
        except:
            pass
            
    verdi = None
    if pd.notna(row['Verdi']):
        try:
            verdi = float(row['Verdi'])
        except:
            pass
            
    merknad = str(row['Merknad']) if pd.notna(row['Merknad']) else None
    
    company_id = 'EQNR.OL' if selskap == 'Equinor ASA' else ('YAR.OL' if selskap == 'Yara International ASA' else None)

    if selskap and gruppe and kategori and aar is not None:
        try:
            cur.execute("""
                INSERT INTO company_financial_data (selskap, company_id, gruppe, kategori, aar, verdi, merknad)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (selskap, gruppe, kategori, aar) 
                DO UPDATE SET verdi = EXCLUDED.verdi, merknad = EXCLUDED.merknad, company_id = EXCLUDED.company_id;
            """, (selskap, company_id, gruppe, kategori, aar, verdi, merknad))
            inserted += 1
        except Exception as e:
            print(f"Error inserting row {index}: {e}")
            conn.rollback()

conn.commit()
cur.close()
conn.close()
print(f"Successfully inserted/updated {inserted} rows.")

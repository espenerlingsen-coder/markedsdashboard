import pandas as pd
import psycopg2
from psycopg2.extras import execute_values
import aksker_config as cfg
from Askeinformasjon_innhenting_supabase import update_urea_middle_east_investing

csv_path = r"C:\Users\espen\Downloads\daily_prices.csv"
print(f"Leser {csv_path} for UREA_ME...")

df = pd.read_csv(csv_path)

# Filtrer kun UREA_ME
df_urea = df[df['ticker'] == 'UREA_ME'].copy()
print(f"Fant {len(df_urea)} rader for Urea.")

if not df_urea.empty:
    with psycopg2.connect(**cfg.SUPABASE_CONFIG) as conn:
        with conn.cursor() as cur:
            # Slett all gammel UREA data først for å fjerne World Bank sine månedlige data
            cur.execute("DELETE FROM daily_prices WHERE ticker = 'UREA_ME'")
            print("Slettet all gammel Urea data for å gi plass til ny, daglig historikk.")

            query = """
                INSERT INTO daily_prices (ticker, date, open_price, close_price, volume)
                VALUES %s
                ON CONFLICT (ticker, date) DO UPDATE 
                SET close_price = EXCLUDED.close_price;
            """
            
            # Sørg for at alt kan konverteres til floats (håndter NaN/tekst)
            df_urea['open_price'] = pd.to_numeric(df_urea['open_price'], errors='coerce').fillna(0)
            df_urea['close_price'] = pd.to_numeric(df_urea['close_price'], errors='coerce').fillna(0)
            df_urea['volume'] = pd.to_numeric(df_urea['volume'], errors='coerce').fillna(0)
            
            values = [(row['ticker'], row['date'], float(row['open_price']), float(row['close_price']), float(row['volume'])) for _, row in df_urea.iterrows()]
            execute_values(cur, query, values)
            print(f"Lagret {len(values)} rader med daglige historiske Urea-priser fra CSV.")

# Kjør oppdateringen mot Investing for å få de helt ferskeste 20 dagene på toppen
update_urea_middle_east_investing()

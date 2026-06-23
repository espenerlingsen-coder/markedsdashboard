from google import genai
from google.genai import types
import yfinance as yf
import psycopg2
from psycopg2.extras import execute_values
import pandas as pd
import json
import os
import requests
import io
import time
from bs4 import BeautifulSoup
from sqlalchemy import create_engine, URL
from datetime import datetime
import aksker_config as cfg

# =========================================================
# 1. KONFIGURASJON & DB-OPPDATERING (SUPABASE)
# =========================================================

GEMINI_MODEL = "gemini-3.1-pro-preview"

client = genai.Client(api_key=cfg.GEMINI_API_KEY)

# Oppdaterer tilkoplingen for å bruke Supabase (krever oftest sslmode='require')
connection_url = URL.create(
    "postgresql+psycopg2",
    username=cfg.SUPABASE_CONFIG['user'],
    password=cfg.SUPABASE_CONFIG['password'],
    host=cfg.SUPABASE_CONFIG['host'],
    port=cfg.SUPABASE_CONFIG['port'],
    database=cfg.SUPABASE_CONFIG['dbname'],
    query={'sslmode': cfg.SUPABASE_CONFIG.get('sslmode', 'require')}
)
engine = create_engine(connection_url)

PROMPT_DIR = "prompts"


def update_database_schema():
    print("⚙️ Sjekker og oppdaterer databaseskjema i Supabase...")
    try:
        with psycopg2.connect(**cfg.SUPABASE_CONFIG) as conn:
            with conn.cursor() as cur:
                # Oppretter basistabeller hvis de ikke finnes (viktig for en helt ny Supabase-database)
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS companies (
                        ticker VARCHAR(50) PRIMARY KEY,
                        name VARCHAR(255),
                        type VARCHAR(50),
                        auto_generate BOOLEAN DEFAULT TRUE
                    );
                """)
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS daily_prices (
                        ticker VARCHAR(50),
                        date TIMESTAMP,
                        open_price DOUBLE PRECISION,
                        close_price DOUBLE PRECISION,
                        volume DOUBLE PRECISION,
                        PRIMARY KEY (ticker, date)
                    );
                """)
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS news_feed (
                        ticker VARCHAR(50),
                        published_at TIMESTAMP,
                        title TEXT,
                        source VARCHAR(255),
                        url TEXT,
                        summary TEXT,
                        relevance_score INTEGER DEFAULT 1,
                        UNIQUE (ticker, title)
                    );
                """)
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS company_news_summary (
                        company_id VARCHAR(50),
                        date DATE,
                        news_summary TEXT,
                        UNIQUE (company_id)
                    );
                """)
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS company_financial_data (
                        id SERIAL PRIMARY KEY,
                        selskap VARCHAR(255),
                        company_id VARCHAR(50),
                        gruppe VARCHAR(255),
                        kategori VARCHAR(255),
                        aar INTEGER,
                        verdi DOUBLE PRECISION,
                        merknad TEXT,
                        UNIQUE(selskap, gruppe, kategori, aar)
                    );
                """)

                # Rydd opp i gamle data for å sikre at det kun er 1 per selskap (slett de eldste)
                cur.execute("""
                    DELETE FROM company_news_summary 
                    WHERE ctid NOT IN (
                        SELECT max(ctid) FROM company_news_summary GROUP BY company_id
                    );
                """)
                
                # Fjern den gamle skjemabegrensningen som tillot flere datoer, legg til ny for kun company_id
                try:
                    cur.execute("ALTER TABLE company_news_summary DROP CONSTRAINT IF EXISTS company_news_summary_company_id_date_key;")
                    cur.execute("ALTER TABLE company_news_summary ADD CONSTRAINT company_news_summary_company_id_key UNIQUE(company_id);")
                except Exception as e:
                    pass # Ignorer om den allerede finnes

                cur.execute("ALTER TABLE companies ADD COLUMN IF NOT EXISTS type VARCHAR(50);")
                cur.execute("ALTER TABLE companies ADD COLUMN IF NOT EXISTS auto_generate BOOLEAN DEFAULT TRUE;")
                cur.execute("""
                    UPDATE companies 
                    SET type = 'commodity', auto_generate = TRUE 
                    WHERE ticker IN ('BZ=F', 'CL=F', 'NG=F', 'TTF=F', 'DAP_WB', 'POTASH_WB', 'UREA_ME');
                """)
                cur.execute("UPDATE companies SET type = 'company' WHERE type IS NULL;")
                
                # Legger til Yara International og Equinor
                cur.execute("""
                    INSERT INTO companies (ticker, name, type, auto_generate) 
                    VALUES 
                        ('YAR.OL', 'Yara International', 'company', TRUE),
                        ('EQNR.OL', 'Equinor', 'company', TRUE)
                    ON CONFLICT (ticker) DO NOTHING;
                """)

                # 1. Oppretter financial_data tabellen med alle kolonner
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS financial_data (
                        company_id VARCHAR(50),
                        year INTEGER,
                        quarter INTEGER,
                        period VARCHAR(10),
                        reported_date DATE,
                        unit VARCHAR(20),
                        financial_group VARCHAR(50),
                        category VARCHAR(255),
                        value DOUBLE PRECISION
                    );
                """)

                # 2. Sikrer at nye kolonner finnes og har riktig størrelse
                cur.execute("ALTER TABLE financial_data ADD COLUMN IF NOT EXISTS reported_date DATE;")
                cur.execute("ALTER TABLE financial_data ADD COLUMN IF NOT EXISTS period VARCHAR(10);")
                cur.execute("ALTER TABLE financial_data ALTER COLUMN category TYPE VARCHAR(255);")
                cur.execute("ALTER TABLE financial_data ALTER COLUMN financial_group TYPE VARCHAR(100);")

                # 3. Oppdaterer unik nøkkel
                cur.execute("ALTER TABLE financial_data DROP CONSTRAINT IF EXISTS financial_data_unique_key;")
                cur.execute("""
                    ALTER TABLE financial_data 
                    ADD CONSTRAINT financial_data_unique_key 
                    UNIQUE (company_id, year, quarter, financial_group, category);
                """)
    except Exception as e:
        print(f"⚠️ Feil under skjemaoppdatering: {e}")


def load_prompt(filename, **kwargs):
    file_path = os.path.join(PROMPT_DIR, filename)
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            return f.read().format(**kwargs)
    except Exception as e:
        print(f"❌ Feil ved lasting av prompt {filename}: {e}")
        return ""


def extract_json_list(text):
    try:
        start = text.find('[')
        end = text.rfind(']') + 1
        if start == -1 or end == 0: return None
        return json.loads(text[start:end])
    except:
        return None


def ensure_company_exists(ticker, name, entity_type="company", auto_generate=True):
    try:
        with psycopg2.connect(**cfg.SUPABASE_CONFIG) as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO companies (ticker, name, type, auto_generate) 
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT (ticker) DO NOTHING;
                """, (ticker, name, entity_type, auto_generate))
    except Exception as e:
        print(f"⚠️ SQL Feil (sjekk selskaper): {e}")


def store_dataframe_to_sql(ticker, df):
    if df.empty: return 0
    try:
        with psycopg2.connect(**cfg.SUPABASE_CONFIG) as conn:
            with conn.cursor() as cur:
                query = """
                    INSERT INTO daily_prices (ticker, date, open_price, close_price, volume)
                    VALUES %s
                    ON CONFLICT (ticker, date) DO UPDATE 
                    SET close_price = EXCLUDED.close_price;
                """
                values = [(ticker, row['Date'], row['Open'], row['Close'], row.get('Volume', 0)) for index, row in df.iterrows()]
                execute_values(cur, query, values)
        return len(values)
    except Exception as e:
        print(f"❌ SQL Feil ved lagring for {ticker}: {e}")
        return 0


# =========================================================
# 2. MARKEDSDATA, RÅVARER & FINANS
# =========================================================

def fetch_and_store_price_history(ticker, period="7y", custom_name=None, entity_type="company"):
    display_name = custom_name if custom_name else ticker
    ensure_company_exists(ticker, display_name, entity_type=entity_type)
    print(f"📉 Henter kurser for {display_name} ({ticker}) for de siste {period}...")
    try:
        stock = yf.Ticker(ticker)
        df = stock.history(period=period)
        if df.empty: return
        df.reset_index(inplace=True)
        count = store_dataframe_to_sql(ticker, df)
        print(f"   ✅ Lagret {count} rader.")
    except Exception as e:
        print(f"   ❌ Feil: {e}")


def fetch_and_store_financials(ticker):
    """Henter ALLE parametere og parer dem med den faktiske rapporteringsdatoen til markedet.
       Sletter først all gammel historikk for selskapet for å unngå 'spøkelsesdata'."""
    print(f"📊 Henter FULLSTENDIG finansiell historikk for {ticker}...")
    try:
        stock = yf.Ticker(ticker)
        currency = stock.info.get('currency', 'Unknown')

        # Henter selskapets historiske rapporteringsdatoer
        try:
            earnings = stock.earnings_dates
            if earnings is not None and not earnings.empty:
                if earnings.index.tz is not None:
                    earnings_list = earnings.index.tz_localize(None).tolist()
                else:
                    earnings_list = earnings.index.tolist()
            else:
                earnings_list = []
        except:
            earnings_list = []

        try:
            inc = stock.quarterly_income_stmt
        except:
            inc = pd.DataFrame()

        try:
            bal = stock.quarterly_balance_sheet
        except:
            bal = pd.DataFrame()

        try:
            cf = stock.quarterly_cashflow
        except:
            cf = pd.DataFrame()

        statements = [(inc, 'P&L'), (bal, 'Balance Sheet'), (cf, 'Cash Flow')]
        records_to_insert = []

        for df, group_name in statements:
            if df is not None and not df.empty:
                for category in df.index:
                    series = df.loc[category]
                    for date, value in series.items():
                        if pd.isna(value): continue

                        year = date.year
                        quarter = (date.month - 1) // 3 + 1
                        period = f"Q{quarter}-{year}"

                        quarter_end = pd.to_datetime(date)
                        actual_reported_date = None

                        if earnings_list:
                            future_dates = [d for d in earnings_list if
                                            d >= quarter_end and (d - quarter_end).days < 120]
                            if future_dates:
                                actual_reported_date = min(future_dates).date()

                        if actual_reported_date is None:
                            actual_reported_date = quarter_end.date()

                        records_to_insert.append((
                            ticker, year, quarter, period, actual_reported_date, currency, group_name, category,
                            float(value)
                        ))

        if not records_to_insert:
            print("   ⚠️ Fant ingen finansdata hos Yahoo Finance.")
            return

        with psycopg2.connect(**cfg.SUPABASE_CONFIG) as conn:
            with conn.cursor() as cur:
                # --- NYTT: Sletter alt for dette spesifikke selskapet før vi bygger opp på nytt ---
                cur.execute("DELETE FROM financial_data WHERE company_id = %s;", (ticker,))

                # Legger inn de helt ferske tallene
                # (Vi beholder ON CONFLICT i tilfelle Yahoo Finance ved en feil har to identiske rader i samme uttrekk)
                query = """
                    INSERT INTO financial_data (company_id, year, quarter, period, reported_date, unit, financial_group, category, value)
                    VALUES %s
                    ON CONFLICT (company_id, year, quarter, financial_group, category) DO UPDATE
                    SET value = EXCLUDED.value, unit = EXCLUDED.unit, period = EXCLUDED.period, reported_date = EXCLUDED.reported_date;
                """
                if records_to_insert:
                    execute_values(cur, query, records_to_insert)
        print(
            f"   ✅ Suksess! Slettet gammel historikk og lagret {len(records_to_insert)} ferske regnskapslinjer for {ticker}.")
    except Exception as e:
        print(f"   ❌ Feil ved henting av finansdata: {e}")


def update_market_data(ticker):
    fetch_and_store_price_history(ticker, period="7y")


def update_commodities():
    print("\n--- Oppdaterer Råvarer (Siste 7 år) ---")
    commodities = {"Brent Crude": "BZ=F", "WTI Crude": "CL=F", "Henry Hub": "NG=F"}
    for name, ticker in commodities.items():
        fetch_and_store_price_history(ticker, period="7y", custom_name=name, entity_type="commodity")

    ensure_company_exists("TTF=F", "TTF Nat Gas", entity_type="commodity")
    try:
        ttf = yf.Ticker("TTF=F").history(period="7y").tz_localize(None)
        fx = yf.Ticker("EURUSD=X").history(period="7y").tz_localize(None)
        if not ttf.empty and not fx.empty:
            df = ttf[['Close', 'Open', 'Volume']].join(fx[['Close']].rename(columns={'Close': 'FX'}), how='inner')
            factor = 3.4121416
            df['Close'] = (df['Close'] * df['FX']) / factor
            df['Open'] = (df['Open'] * df['FX']) / factor
            df.reset_index(inplace=True)
            df.rename(columns={'index': 'Date'}, inplace=True)
            count = store_dataframe_to_sql("TTF=F", df)
            print(f"   ✅ TTF oppdatert ({count} rader lagret).")
    except Exception as e:
        print(f"   ❌ TTF Feil: {e}")


def update_fertilizers_from_world_bank():
    print("\n--- Oppdaterer Globale Gjødselpriser (Verdensbanken) ---")
    ensure_company_exists("DAP_WB", "DAP - Fosfor (World Bank)", entity_type="commodity")
    ensure_company_exists("POTASH_WB", "Potash - Kalium (World Bank)", entity_type="commodity")

    try:
        url = "https://www.worldbank.org/en/research/commodity-markets"
        soup = BeautifulSoup(requests.get(url).content, 'html.parser')
        link = next(
            (l['href'] for l in soup.find_all('a', href=True) if '.xlsx' in l['href'] and 'Monthly' in l['href']), None)
        if not link: return
        if not link.startswith('http'): link = "https://www.worldbank.org" + link

        df = pd.read_excel(io.BytesIO(requests.get(link).content), sheet_name='Monthly Prices', header=4)
        df.rename(columns={df.columns[0]: 'Date'}, inplace=True)

        def parse_date(d):
            try:
                return datetime(int(d.split('M')[0]), int(d.split('M')[1]), 1)
            except:
                return pd.NaT

        df['Date'] = df['Date'].apply(parse_date)
        targets = {"DAP_WB": "dap", "POTASH_WB": "potassium"}

        with psycopg2.connect(**cfg.SUPABASE_CONFIG) as conn:
            with conn.cursor() as cur:
                for ticker, search_term in targets.items():
                    col = next((c for c in df.columns if search_term in str(c).lower()), None)
                    if col:
                        df[col] = pd.to_numeric(df[col], errors='coerce')
                        temp_df = df.dropna(subset=['Date', col])
                        query = """
                            INSERT INTO daily_prices (ticker, date, open_price, close_price, volume) 
                            VALUES %s 
                            ON CONFLICT (ticker, date) DO UPDATE SET close_price = EXCLUDED.close_price
                        """
                        values = [(ticker, row['Date'], float(row[col]), float(row[col]), 0) for _, row in temp_df.iterrows()]
                        if values:
                            execute_values(cur, query, values)
                        print(f"   ✅ Lagret {ticker} (Fant {len(values)} måneder med data).")
    except Exception as e:
        print(f"   ❌ Feil ved nedlasting av gjødseldata: {e}")


def update_urea_middle_east_investing():
    print("\n--- Oppdaterer Urea FOB Middle East (Investing.com) ---")
    ticker = "UREA_ME"
    ensure_company_exists(ticker, "Urea Granular FOB Middle East", entity_type="commodity")

    url = "https://www.investing.com/commodities/urea-granular-fob-middle-east-futures-historical-data"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.google.com/"
    }

    try:
        res = requests.get(url, headers=headers, timeout=15)
        if res.status_code != 200:
            print(f"   ❌ Fikk statuskode {res.status_code}. Investing.com har trolig blokkert tilgangen.")
            return

        tables = pd.read_html(io.StringIO(res.text))
        df = next((t for t in tables if "Date" in t.columns and "Price" in t.columns), None)

        if df is None or df.empty:
            print("   ⚠️ Fant ingen tabell med priser på siden.")
            return

        df['Date'] = pd.to_datetime(df['Date'], errors='coerce')
        df.rename(columns={'Price': 'Close'}, inplace=True)
        df['Close'] = pd.to_numeric(df['Close'].astype(str).str.replace(',', ''), errors='coerce')
        if 'Open' in df.columns:
            df['Open'] = pd.to_numeric(df['Open'].astype(str).str.replace(',', ''), errors='coerce')
        else:
            df['Open'] = df['Close']
        df['Volume'] = 0

        df = df.dropna(subset=['Date', 'Close'])
        count = store_dataframe_to_sql(ticker, df)
        print(f"   ✅ Lagret {count} dager med historikk for Urea (Middle East).")

    except Exception as e:
        print(f"   ❌ Feil ved skraping: {e}")


def get_gemini_daily_news(company_name, ticker):
    print(f"\n📰 [Nyheter] Søker etter dagens nyheter for {company_name}...")
    prompt = load_prompt("daily_news.txt", company_name=company_name, ticker=ticker)
    if not prompt: return []
    try:
        res = client.models.generate_content(
            model=GEMINI_MODEL, contents=prompt,
            config=types.GenerateContentConfig(tools=[types.Tool(google_search=types.GoogleSearch())])
        )
        return extract_json_list(res.text) or []
    except Exception as e:
        print(f"   ❌ Feil ved kommunikasjon med Gemini: {e}")
        return []


def update_daily_news_feed(ticker, company_name):
    news = get_gemini_daily_news(company_name, ticker)
    if not news: return
    try:
        with psycopg2.connect(**cfg.SUPABASE_CONFIG) as conn:
            with conn.cursor() as cur:
                news_values = []
                for n in news:
                    raw_date = str(n.get('published_at', ''))
                    if len(raw_date) == 18 and raw_date[10].isdigit(): raw_date = raw_date[:10] + ' ' + raw_date[10:]
                    try:
                        clean_date = pd.to_datetime(raw_date).strftime('%Y-%m-%d %H:%M:%S')
                    except:
                        clean_date = datetime.now().strftime('%Y-%m-%d %H:%M:%S')

                    news_values.append((ticker, clean_date, n.get('title'), n.get('source'), n.get('url'), n.get('summary'), 1))

                if news_values:
                    query = """
                        INSERT INTO news_feed (ticker, published_at, title, source, url, summary, relevance_score)
                        VALUES %s
                        ON CONFLICT (ticker, title) DO NOTHING; 
                    """
                    execute_values(cur, query, news_values)
        print(f"   ✅ {len(news)} nyheter behandlet.")
    except Exception as e:
        print(f"   ❌ SQL Feil: {e}")


def clean_and_score_news(ticker, company_name):
    print(f"\n🧹 [Cleanup] Vasker og scorer nyheter for {ticker}...")
    try:
        with psycopg2.connect(**cfg.SUPABASE_CONFIG) as conn:
            with conn.cursor() as cur: cur.execute(
                "ALTER TABLE news_feed ADD COLUMN IF NOT EXISTS relevance_score INTEGER DEFAULT 1;")
    except:
        pass

    try:
        df = pd.read_sql(
            f"SELECT title, source, summary, published_at FROM news_feed WHERE ticker = '{ticker}' AND published_at >= CURRENT_DATE - INTERVAL '10 days'",
            engine)
    except:
        df = pd.DataFrame()
    if df.empty: return

    prompt = load_prompt("news_cleanup.txt", company_name=company_name,
                         news_json=json.dumps(df.to_dict(orient='records'), default=str))
    if not prompt: return

    try:
        res = client.models.generate_content(
            model=GEMINI_MODEL, contents=prompt,
            config=types.GenerateContentConfig(response_mime_type="application/json")
        )
        cleaned_data = extract_json_list(res.text)
        if not cleaned_data: return

        with psycopg2.connect(**cfg.SUPABASE_CONFIG) as conn:
            with conn.cursor() as cur:
                del_c = upd_c = 0
                for item in cleaned_data:
                    if item.get('action') == 'DELETE':
                        cur.execute("DELETE FROM news_feed WHERE ticker = %s AND title = %s",
                                    (ticker, item.get('title')))
                        del_c += 1
                    elif item.get('action') == 'KEEP':
                        cur.execute("UPDATE news_feed SET relevance_score = %s WHERE ticker = %s AND title = %s",
                                    (item.get('score', 1), ticker, item.get('title')))
                        upd_c += 1
        print(f"   ✨ Ferdig! Slettet {del_c}, oppdaterte score på {upd_c} artikler.")
    except Exception as e:
        print(f"   ❌ Feil: {e}")


def should_update_company_news(ticker):
    try:
        with psycopg2.connect(**cfg.SUPABASE_CONFIG) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT MAX(date) FROM company_news_summary WHERE company_id = %s", (ticker,))
                result = cur.fetchone()[0]
                if result is None:
                    return True
                # True hvis nyeste dato er før i dag
                return result < datetime.now().date()
    except Exception as e:
        print(f"⚠️ Feil ved sjekk av nyhetsdato for {ticker}: {e}")
        return True


def save_weekly_summary_to_db(ticker, text):
    try:
        with psycopg2.connect(**cfg.SUPABASE_CONFIG) as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO company_news_summary (company_id, date, news_summary) 
                    VALUES (%s, CURRENT_DATE, %s) 
                    ON CONFLICT (company_id) DO UPDATE SET news_summary = EXCLUDED.news_summary, date = EXCLUDED.date;
                """, (ticker, text))
    except Exception as e:
        print(f"      ❌ SQL FEIL: {e}")


def run_ai_analysis(ticker, name, prompt_file, is_company=False):
    icon = "🧠" if is_company else "🔥"
    print(f"\n{icon} Analyserer {name}...")
    try:
        if is_company:
            try:
                df = pd.read_sql(
                    f"SELECT published_at, title, source, summary, relevance_score FROM news_feed WHERE ticker = '{ticker}' AND published_at >= CURRENT_DATE - INTERVAL '7 days' ORDER BY relevance_score DESC, published_at ASC",
                    engine)
            except:
                df = pd.DataFrame()
            if df.empty:
                print("   ⚠️ Ingen nyheter. Hopper over.")
                return
            context = "".join([
                                  f"DATO: {r['published_at']} | SCORE: {r.get('relevance_score', 1)} | KILDE: {r['source']}\nTIT: {r['title']}\nSUM: {r['summary']}\n---\n"
                                  for _, r in df.iterrows()])
            prompt = load_prompt(prompt_file, company_name=name, ticker=ticker, context=context)
        else:
            limit = 30
            df = pd.read_sql(
                f"SELECT date, close_price FROM daily_prices WHERE ticker = '{ticker}' ORDER BY date DESC LIMIT {limit}",
                engine)
            history = df.sort_values('date').to_string(index=False) if not df.empty else "Ingen historikk."
            prompt = load_prompt(prompt_file, name=name, ticker=ticker, price_history=history)

        if not prompt: return

        time.sleep(2)
        res = client.models.generate_content(
            model=GEMINI_MODEL, contents=prompt,
            config=types.GenerateContentConfig(
                tools=[types.Tool(google_search=types.GoogleSearch())]) if not is_company else None
        )
        if res.text:
            save_weekly_summary_to_db(ticker, res.text.strip())
            print(f"   ✅ Analyse fullført.")
    except Exception as e:
        print(f"   ⚠️ Feil under analyse: {e}")


# =========================================================
# 5. HOVEDPROGRAM (DATABASE-DREVET)
# =========================================================

if __name__ == "__main__":
    print(f"🚀 STARTER DATABASESPØRRING OG INNHENTING TIL SUPABASE (v21 - {GEMINI_MODEL})")
    print("=============================================================")

    update_database_schema()

    # --- DEL A: GLOBALE RÅVARER ---
    update_commodities()
    update_fertilizers_from_world_bank()
    update_urea_middle_east_investing()

    if should_update_company_news("TTF=F"):
        run_ai_analysis("TTF=F", "TTF Natural Gas (Europe)", "gas_analysis.txt")
    if should_update_company_news("NG=F"):
        run_ai_analysis("NG=F", "Henry Hub Natural Gas (USA)", "gas_analysis.txt")
    if should_update_company_news("BZ=F"):
        run_ai_analysis("BZ=F", "Brent Crude Olje", "oil_analysis.txt")
    if should_update_company_news("UREA_ME"):
        run_ai_analysis("UREA_ME", "Urea Granular FOB Middle East", "urea_analysis.txt")

    # --- DEL B: SELSKAPER ---
    active_companies = []
    try:
        with psycopg2.connect(**cfg.SUPABASE_CONFIG) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT ticker, name FROM companies WHERE type = 'company' AND auto_generate = TRUE;")
                active_companies = cur.fetchall()
    except Exception as e:
        print(f"❌ Klarte ikke hente selskaper fra DB: {e}")

    for ticker, company_name in active_companies:
        print(f"\n===========================================")
        print(f"👉 PROSESSERER: {company_name} ({ticker})")
        print(f"===========================================")

        update_market_data(ticker)
        fetch_and_store_financials(ticker)
        
        if should_update_company_news(ticker):
            update_daily_news_feed(ticker, company_name)
            clean_and_score_news(ticker, company_name)
            run_ai_analysis(ticker, company_name, "weekly_analysis.txt", is_company=True)
        else:
            print(f"   ⏩ Hopper over nyheter og analyse for {company_name} (allerede oppdatert i dag).")

    print("\n✅ Ferdig! Pipeline complete.")

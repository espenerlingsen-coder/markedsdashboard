// ==========================================
// ⚠️ VIKTIG: SETT INN DINE SUPABASE-NØKLER HER
// ==========================================
// Du finner disse i Supabase Dashboard -> Settings -> API
const SUPABASE_URL = 'https://scjwctfouvrpxmoapkhm.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_YPSVuPmNNhNocSEKNApbPQ_77GuD_21';

const headers = {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
};

// Initialize Supabase Client
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Chart instances
let stockChartInstance = null;
let gasChartInstance = null;
let ureaChartInstance = null;
let oilChartInstance = null;

// Global Chart Config for dark mode
Chart.defaults.color = '#94a3b8';
Chart.defaults.borderColor = 'rgba(255, 255, 255, 0.05)';
Chart.defaults.font.family = "'Inter', sans-serif";

// Global Crosshair Plugin
Chart.register({
    id: 'crosshair',
    afterDraw: chart => {
        if (chart.tooltip?._active?.length) {
            let activePoint = chart.tooltip._active[0];
            let ctx = chart.ctx;
            let x = activePoint.element.x;
            let y = activePoint.element.y;
            let topY = chart.scales.y.top;
            let bottomY = chart.scales.y.bottom;
            let leftX = chart.scales.x.left;
            let rightX = chart.scales.x.right;
            
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(x, topY);
            ctx.lineTo(x, bottomY);
            ctx.moveTo(leftX, y);
            ctx.lineTo(rightX, y);
            ctx.lineWidth = 1;
            ctx.strokeStyle = 'rgba(56, 189, 248, 0.4)'; // Thin light blue
            ctx.setLineDash([5, 5]); // Dashed lines
            ctx.stroke();
            ctx.restore();
        }
    }
});

// State for data
let currentTimeFilter = 'YTD';
let globalStockData = [];
let globalHhData = [];
let globalTtfData = [];
let globalUreaData = [];
let globalOilData = [];
let globalCommodityAnalysis = {};

let currentCommodityTicker = null;
let currentCommodityTimeFilter = 'YTD';
let commodityChartInstance = null;

document.addEventListener('DOMContentLoaded', () => {
    setupAuth();
});

// ==========================================
// AUTHENTICATION LOGIC
// ==========================================
async function setupAuth() {
    // Sjekk om vi har en aktiv sesjon
    const { data: { session }, error } = await supabaseClient.auth.getSession();
    
    if (session) {
        handleAuthChange(session);
    }

    // Lytt til endringer i auth-status (innlogging / utlogging)
    supabaseClient.auth.onAuthStateChange((_event, session) => {
        handleAuthChange(session);
    });
}

function handleAuthChange(session) {
    if (session) {
        // Oppdater headers med access token
        headers.Authorization = `Bearer ${session.access_token}`;
        
        // Vis app, skjul login
        document.getElementById('auth-view').style.display = 'none';
        document.getElementById('app-container').style.display = 'block';
        
        // Initialiser appen hvis den ikke er gjort enda
        if (!document.getElementById('companySelect').options.length || document.getElementById('companySelect').options[0].value === 'YAR.OL') {
            initApp();
        }
    } else {
        // Fjern access token fra headers (fallback til anon key)
        headers.Authorization = `Bearer ${SUPABASE_ANON_KEY}`;
        
        // Vis login, skjul app
        document.getElementById('auth-view').style.display = 'flex';
        document.getElementById('app-container').style.display = 'none';
    }
}

async function handleLogin(event) {
    event.preventDefault(); // Unngå at formen laster siden på nytt
    
    const email = document.getElementById('auth-email').value;
    const password = document.getElementById('auth-password').value;
    const errorDiv = document.getElementById('auth-error');
    
    errorDiv.style.display = 'none';
    
    const { data, error } = await supabaseClient.auth.signInWithPassword({
        email: email,
        password: password,
    });
    
    if (error) {
        errorDiv.textContent = "Feil epost eller passord.";
        errorDiv.style.display = 'block';
    }
}

async function handleLogout() {
    const { error } = await supabaseClient.auth.signOut();
    if (error) {
        console.error("Feil ved utlogging:", error);
    }
}

async function initApp() {
    await loadCompanies();
    
    const select = document.getElementById('companySelect');
    
    // Set default to YAR.OL if it exists
    if (Array.from(select.options).some(opt => opt.value === 'YAR.OL')) {
        select.value = "YAR.OL";
    }
    
    select.addEventListener('change', (e) => {
        loadDashboard(e.target.value, select.options[select.selectedIndex].text);
    });

    // Time filter buttons
    const timeBtns = document.querySelectorAll('#dashboard-view .time-btn');
    timeBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            const period = e.target.getAttribute('data-period');
            if (!period) return; // Unngå at "Tilbake"-knappen trigger dette hvis den deler klasse
            
            timeBtns.forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            currentTimeFilter = period;
            
            // Re-render charts
            if (globalStockData.length) renderStockChart(globalStockData);
            if (globalHhData.length && globalTtfData.length) renderGasChart(globalHhData, globalTtfData);
            if (globalUreaData.length) renderUreaChart(globalUreaData);
            if (globalOilData.length) renderOilChart(globalOilData);
        });
    });

    // Time filter buttons for commodity view
    const cTimeBtns = document.querySelectorAll('.c-time-btn');
    cTimeBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            cTimeBtns.forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            currentCommodityTimeFilter = e.target.getAttribute('data-period');
            
            if (currentCommodityTicker) {
                renderCommodityChart(currentCommodityTicker);
            }
        });
    });

    // Last inn felles råvarer og analyser kun én gang (caching)
    await loadCommodityData();

    if(select.value) {
        loadDashboard(select.value, select.options[select.selectedIndex].text);
    }
}

// Hjelpefunksjon for å formatere tall med tusenskilletegn og komma
function formatNumber(num) {
    if (num === null || num === undefined) return "N/A";
    return num.toLocaleString('no-NO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Enkle hjelpefunksjoner for lasting/feil
function showLoadingState() {
    // Vis Laster... i grafene uten å fjerne selve canvaset
    ['stockChart', 'gasChart', 'ureaChart', 'oilChart'].forEach(id => {
        const el = document.getElementById(id);
        if (el && el.parentElement) {
            const parent = el.parentElement;
            if (!parent.querySelector('.loading-overlay')) {
                const overlay = document.createElement('div');
                overlay.className = 'loading-overlay';
                overlay.textContent = 'Laster...';
                parent.appendChild(overlay);
            }
        }
    });
    
    // Nullstill KPI-er
    document.getElementById('latest-price').textContent = "Laster...";
    document.getElementById('change-1d').textContent = "-";
    document.getElementById('change-1w').textContent = "-";
    document.getElementById('change-1m').textContent = "-";
    document.getElementById('change-1y').textContent = "-";
    
    // Tøm nyheter og analyse
    document.getElementById('news-container').innerHTML = '<p>Laster...</p>';
    const newsEl = document.getElementById('news-container');
    const aiEl = document.getElementById('ai-analysis-content');
    if (newsEl) newsEl.innerHTML = '<p>Laster...</p>';
    if (aiEl) aiEl.innerHTML = '<p>Laster...</p>';
}

function showErrorState(msg) {
    console.error(msg);
    const errHtml = `<div style="color: var(--negative); font-weight: bold; padding: 2rem;">Feil ved lasting: ${msg}</div>`;
    const sc = document.getElementById('stockChart');
    if (sc) sc.parentElement.innerHTML = errHtml;
    
    // Nullstill KPI-er
    const lp = document.getElementById('latest-price');
    if (lp) lp.textContent = "Feil";
}

function showDashboard() {
    document.getElementById('dashboard-view').style.display = 'block';
    const cv = document.getElementById('commodity-view');
    if(cv) cv.style.display = 'none';
    const civ = document.getElementById('company-info-view');
    if(civ) civ.style.display = 'none';
    
    setTimeout(() => {
        if (globalStockData.length > 0) renderStockChart(globalStockData);
        if (globalHhData.length > 0 && globalTtfData.length > 0) renderGasChart(globalHhData, globalTtfData);
        if (globalUreaData.length > 0) renderUreaChart(globalUreaData);
        if (globalOilData.length > 0) renderOilChart(globalOilData);
    }, 50);
}

function showCompanyInfoView() {
    document.getElementById('dashboard-view').style.display = 'none';
    const cv = document.getElementById('commodity-view');
    if(cv) cv.style.display = 'none';
    document.getElementById('company-info-view').style.display = 'block';
}

function hideCompanyInfoView() {
    showDashboard();
}

function showCommodityView(ticker) {
    document.getElementById('dashboard-view').style.display = 'none';
    document.getElementById('commodity-view').style.display = 'block';
    currentCommodityTicker = ticker;
    
    // Sett logo
    const logoEl = document.getElementById('commodity-view-logo');
    if (ticker === 'TTF=F') logoEl.src = 'ttf_icon.png';
    else if (ticker === 'NG=F') logoEl.src = 'hh_icon.png';
    else if (ticker === 'UREA_ME') logoEl.src = 'urea_icon.png';
    else if (ticker === 'BZ=F') logoEl.src = 'oil_icon.png';
    
    // Sett tittel og enhet
    const titleEl = document.getElementById('commodity-chart-title');
    const unitEl = document.getElementById('commodity-chart-unit');
    const unitLabelEl = document.getElementById('commodity-unit-label');
    
    if (ticker === 'TTF=F') { titleEl.textContent = 'TTF Gass Historikk'; unitEl.textContent = 'USD/MmBTU'; unitLabelEl.textContent = 'USD/MmBTU'; }
    if (ticker === 'NG=F') { titleEl.textContent = 'Henry Hub Historikk'; unitEl.textContent = 'USD/MmBTU'; unitLabelEl.textContent = 'USD/MmBTU'; }
    if (ticker === 'UREA_ME') { titleEl.textContent = 'Urea Historikk'; unitEl.textContent = 'USD/tonn'; unitLabelEl.textContent = 'USD/tonn'; }
    if (ticker === 'BZ=F') { titleEl.textContent = 'Brent Crude Historikk'; unitEl.textContent = 'USD/fat'; unitLabelEl.textContent = 'USD/fat'; }

    renderCommodityDashboard(ticker);
}

function renderCommodityDashboard(ticker) {
    let data = [];
    if (ticker === 'TTF=F') data = globalTtfData;
    else if (ticker === 'NG=F') data = globalHhData;
    else if (ticker === 'UREA_ME') data = globalUreaData;
    else if (ticker === 'BZ=F') data = globalOilData;
    
    // Oppdater KPIer for råvaren
    if(data.length > 0) {
        const latestData = data[data.length-1];
        const latest = latestData.close_price;
        document.getElementById('commodity-latest-price').textContent = formatNumber(latest);
        
        const latestDateStr = latestData.date; 
        const latestDateObj = new Date(latestDateStr);

        const updateChange = (elementId, daysBack) => {
            const el = document.getElementById(elementId);
            const targetDate = new Date(latestDateObj);
            targetDate.setDate(targetDate.getDate() - daysBack);
            const targetStr = targetDate.toISOString().split('T')[0];

            let prevData = null;
            for (let i = data.length - 2; i >= 0; i--) {
                if (data[i].date <= targetStr) {
                    prevData = data[i];
                    break;
                }
            }

            if(prevData) {
                const prev = prevData.close_price;
                const change = latest - prev;
                const changePct = (change / prev) * 100;
                const sign = change >= 0 ? '+' : '';
                el.textContent = `${sign}${formatNumber(change)} (${sign}${formatNumber(changePct)}%)`;
                el.className = 'kpi-change ' + (change >= 0 ? 'positive' : 'negative');
            } else {
                el.textContent = "N/A";
                el.className = 'kpi-change';
            }
        };

        updateChange('commodity-change-1d', 1);
        updateChange('commodity-change-1w', 7);
        updateChange('commodity-change-1m', 30);
        updateChange('commodity-change-1y', 365);
    } else {
        document.getElementById('commodity-latest-price').textContent = "N/A";
        document.getElementById('commodity-change-1d').textContent = "-";
        document.getElementById('commodity-change-1w').textContent = "-";
        document.getElementById('commodity-change-1m').textContent = "-";
        document.getElementById('commodity-change-1y').textContent = "-";
    }

    renderCommodityChart(ticker);
    
    // Sett analyse
    const contentEl = document.getElementById('commodity-view-analysis-content');
    const headingEl = document.getElementById('commodity-view-analysis-heading');
    
    const analysisItem = globalCommodityAnalysis[ticker];
    if(analysisItem && analysisItem.news_summary) {
        let updateDate = analysisItem.date;
        if (updateDate && updateDate.includes('-')) {
            const parts = updateDate.split('-');
            updateDate = `${parts[2]}.${parts[1]}.${parts[0]}`;
        }
        headingEl.textContent = `Markedsanalyse (${updateDate})`;
        let parsedText = analysisItem.news_summary
            .replace(/^### (.*$)/gim, '<h4>$1</h4>')
            .replace(/^## (.*$)/gim, '<h3>$1</h3>')
            .replace(/^\*\*([^*]+)\*\*/gim, '<strong>$1</strong>')
            .replace(/\n\n/g, '<br><br>');
            
        contentEl.innerHTML = parsedText;
    } else {
        headingEl.textContent = 'Markedsanalyse';
        contentEl.innerHTML = '<p>Ingen analyse funnet.</p>';
    }
}

function renderCommodityChart(ticker) {
    let rawData = [];
    let color = '#38bdf8';
    let bgColor = 'rgba(56, 189, 248, 0.1)';
    let label = '';
    
    if (ticker === 'TTF=F') { rawData = globalTtfData; color = '#f97316'; bgColor = 'rgba(249, 115, 22, 0.1)'; label = 'TTF (USD/MmBTU)'; }
    if (ticker === 'NG=F') { rawData = globalHhData; color = '#3b82f6'; bgColor = 'rgba(59, 130, 246, 0.1)'; label = 'Henry Hub (USD/MmBTU)'; }
    if (ticker === 'UREA_ME') { rawData = globalUreaData; color = '#10b981'; bgColor = 'rgba(16, 185, 129, 0.1)'; label = 'Urea (USD/tonn)'; }
    if (ticker === 'BZ=F') { rawData = globalOilData; color = '#eab308'; bgColor = 'rgba(234, 179, 8, 0.1)'; label = 'Brent Crude (USD/fat)'; }

    const recentData = filterDate(rawData, currentCommodityTimeFilter);
    const ctx = document.getElementById('commodityChart').getContext('2d');
    if(commodityChartInstance) commodityChartInstance.destroy();

    commodityChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: recentData.map(d => formatDate(d.date)),
            datasets: [{
                label: label,
                data: recentData.map(d => d.close_price),
                borderColor: color, 
                backgroundColor: bgColor,
                borderWidth: 2,
                pointRadius: 0,
                pointHoverRadius: 4,
                fill: true,
                tension: 0.1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { intersect: false, mode: 'index' },
            plugins: { legend: { display: false }, tooltip: { padding: 10 } },
            scales: { x: { ticks: { maxTicksLimit: 8 } } }
        }
    });
}

async function loadCompanies() {
    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/companies?type=eq.company&select=*&order=name`, { headers });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        
        const select = document.getElementById('companySelect');
        select.innerHTML = ''; // Clear options
        
        data.forEach(company => {
            const option = document.createElement('option');
            option.value = company.ticker;
            option.textContent = company.name;
            select.appendChild(option);
        });
    } catch (err) {
        console.error("Feil ved lasting av selskaper:", err);
        document.getElementById('companySelect').innerHTML = '<option value="">Feil ved lasting</option>';
    }
}

async function loadDashboard(ticker, companyName) {
    // Sett logo
    const logoImg = document.getElementById('company-logo');
    if (companyName) {
        if (ticker === 'EQNR.OL') {
            logoImg.src = 'https://upload.wikimedia.org/wikipedia/commons/c/c6/Equinor.svg';
            logoImg.style.display = 'block';
            logoImg.onerror = null;
        } else {
            // Bedre logikk for å finne domene. Hardkoder Yara for sikkerhets skyld hvis YAR.OL.
            let domain = companyName.split(' ')[0].toLowerCase().replace(/[^a-z]/g, '') + '.com';
            if (ticker === 'YAR.OL') domain = 'yara.com';
            
            // Prøv Clearbit først, som gir finere logoer.
            logoImg.src = `https://logo.clearbit.com/${domain}`;
            logoImg.style.display = 'block';
            
            logoImg.onerror = () => { 
                // Fallback til Google Favicon hvis Clearbit feiler
                if (!logoImg.src.includes('google.com')) {
                    logoImg.src = `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
                } else {
                    logoImg.style.display = 'none'; 
                }
            };
        }
    } else {
        logoImg.style.display = 'none';
    }

    // Sett loading state
    showLoadingState();

    try {
        // Last inn selskapsspesifikke data i parallell
        await Promise.all([
            loadStockData(ticker),
            loadCompanyNews(ticker),
            loadCompanyAnalysis(ticker),
            loadCompanyFinancials(ticker)
        ]);
        
        // Dynamisk layout avhengig av selskap
        const cardOil = document.getElementById('card-oil');
        const cardGas = document.getElementById('card-gas');
        const cardUrea = document.getElementById('card-urea');
        
        // Skjul alle råvaregrafer som standard
        cardOil.style.display = 'none';
        cardGas.style.display = 'none';
        cardUrea.style.display = 'none';
        
        if (ticker === 'YAR.OL') {
            cardUrea.style.display = 'block';
            cardUrea.style.order = 2; // Etter aksje
            cardGas.style.display = 'block';
            cardGas.style.order = 3;
        } else if (ticker === 'EQNR.OL') {
            cardOil.style.display = 'block';
            cardOil.style.order = 2; // Etter aksje
            cardGas.style.display = 'block';
            cardGas.style.order = 3;
        }
        
        // Når selskapsdata er ferdig, re-tegn råvaregrafene også 
        // slik at the loading-overlay i gasChart, ureaChart, oilChart forsvinner
        if (globalHhData.length && globalTtfData.length) renderGasChart(globalHhData, globalTtfData);
        if (globalUreaData.length) renderUreaChart(globalUreaData);
        if (globalOilData.length) renderOilChart(globalOilData);
        
    } catch(err) {
        showErrorState(err.message);
    }
}

async function loadCommodityData() {
    try {
        // Hent TTF
        const ttfRes = await fetch(`${SUPABASE_URL}/rest/v1/daily_prices?ticker=eq.${encodeURIComponent('TTF=F')}&select=ticker,date,close_price&order=date.desc&limit=1000`, { headers });
        if (!ttfRes.ok) throw new Error("TTF feil: " + await ttfRes.text());
        const ttfData = (await ttfRes.json()).reverse();

        // Hent Henry Hub
        const hhRes = await fetch(`${SUPABASE_URL}/rest/v1/daily_prices?ticker=eq.${encodeURIComponent('NG=F')}&select=ticker,date,close_price&order=date.desc&limit=1000`, { headers });
        if (!hhRes.ok) throw new Error("HH feil: " + await hhRes.text());
        const hhData = (await hhRes.json()).reverse();

        // Hent Urea
        const ureaRes = await fetch(`${SUPABASE_URL}/rest/v1/daily_prices?ticker=eq.UREA_ME&select=ticker,date,close_price&order=date.desc&limit=1000`, { headers });
        if (!ureaRes.ok) throw new Error("Urea feil: " + await ureaRes.text());
        const ureaData = (await ureaRes.json()).reverse();
        
        // Hent Olje (Brent)
        const oilRes = await fetch(`${SUPABASE_URL}/rest/v1/daily_prices?ticker=eq.${encodeURIComponent('BZ=F')}&select=ticker,date,close_price&order=date.desc&limit=1000`, { headers });
        if (!oilRes.ok) throw new Error("Olje feil: " + await oilRes.text());
        const oilData = (await oilRes.json()).reverse();
        
        globalHhData = hhData;
        globalTtfData = ttfData;
        globalUreaData = ureaData;
        globalOilData = oilData;

        renderGasChart(globalHhData, globalTtfData);
        renderUreaChart(globalUreaData);
        renderOilChart(globalOilData);

        // Hent råvareanalyser
        loadCommodityAnalysis();

    } catch(err) {
        console.error("Feil ved henting av råvarer:", err);
        const errHtml = `<div style="color: var(--negative); font-weight: bold; padding: 2rem;">Feil: ${err.message}</div>`;
        const gasParent = document.getElementById('gasChart')?.parentElement;
        if (gasParent) gasParent.innerHTML = errHtml;
        const ureaParent = document.getElementById('ureaChart')?.parentElement;
        if (ureaParent) ureaParent.innerHTML = errHtml;
        const oilParent = document.getElementById('oilChart')?.parentElement;
        if (oilParent) oilParent.innerHTML = errHtml;
    }
}

async function loadStockData(ticker) {
    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/daily_prices?ticker=eq.${ticker}&select=date,close_price&order=date.desc&limit=2000`, { headers });
        if (!res.ok) throw new Error("Aksje feil");
        const data = (await res.json()).reverse();
        
        globalStockData = data;

        if(data.length > 0) {
            const latestData = data[data.length-1];
            const latest = latestData.close_price;
            document.getElementById('latest-price').textContent = formatNumber(latest);
            
            const latestDateStr = latestData.date; // e.g. "2026-06-15"
            const latestDateObj = new Date(latestDateStr);

            const updateChange = (elementId, daysBack) => {
                const el = document.getElementById(elementId);
                
                // Finn dato vi ser etter
                const targetDate = new Date(latestDateObj);
                targetDate.setDate(targetDate.getDate() - daysBack);
                const targetStr = targetDate.toISOString().split('T')[0];

                // Finn den første raden som er eldre eller lik targetStr
                // Siden data er sortert eldste først (reverse() ble kalt), må vi lete baklengs
                let prevData = null;
                for (let i = data.length - 2; i >= 0; i--) {
                    if (data[i].date <= targetStr) {
                        prevData = data[i];
                        break;
                    }
                }

                if(prevData) {
                    const prev = prevData.close_price;
                    const change = latest - prev;
                    const changePct = (change / prev) * 100;
                    const sign = change >= 0 ? '+' : '';
                    el.textContent = `${sign}${formatNumber(change)} (${sign}${formatNumber(changePct)}%)`;
                    el.className = 'kpi-change ' + (change >= 0 ? 'positive' : 'negative');
                } else {
                    el.textContent = "N/A";
                    el.className = 'kpi-change';
                }
            };

            // Ekte dager tilbake (kalender) for 1D, 1W, 1M, 1Y
            updateChange('change-1d', 1);
            updateChange('change-1w', 7);
            updateChange('change-1m', 30);
            updateChange('change-1y', 365);

        } else {
            document.getElementById('latest-price').textContent = "N/A";
            document.getElementById('change-1d').textContent = "-";
            document.getElementById('change-1w').textContent = "-";
            document.getElementById('change-1m').textContent = "-";
            document.getElementById('change-1y').textContent = "-";
        }

        renderStockChart(globalStockData);
    } catch(err) {
        console.error("Feil ved henting av aksjekurs:", err);
    }
}

async function loadCompanyNews(ticker) {
    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/news_feed?ticker=eq.${ticker}&select=*&order=published_at.desc&limit=10`, { headers });
        if (!res.ok) throw new Error("Nyheter feil");
        const data = await res.json();
        
        const container = document.getElementById('news-container');
        container.innerHTML = '';
        
        if(data.length === 0) {
            container.innerHTML = '<p>Ingen nyheter funnet i databasen.</p>';
            return;
        }

        data.forEach(news => {
            const div = document.createElement('div');
            div.className = 'news-item';
            
            const date = new Date(news.published_at).toLocaleDateString('no-NO', { 
                day: '2-digit', month: 'short', year: 'numeric' 
            });
            
            div.innerHTML = `
                <div class="news-meta">${date} | ${news.source}</div>
                <div class="news-title">
                    <a href="${news.url}" target="_blank">${news.title}</a>
                </div>
                ${news.summary ? `<div class="news-summary">${news.summary}</div>` : ''}
            `;
            container.appendChild(div);
        });
    } catch(err) {
        console.error("Feil ved henting av nyheter:", err);
    }
}

async function loadCompanyAnalysis(ticker) {
    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/company_news_summary?company_id=eq.${ticker}&select=date,news_summary&order=date.desc&limit=1`, { headers });
        if (!res.ok) throw new Error("Analyse feil");
        const data = await res.json();
        
        const contentEl = document.getElementById('ai-analysis-content');
        const headingEl = document.getElementById('analysis-heading');
        
        if(data.length > 0 && data[0].news_summary) {
            let updateDate = data[0].date;
            // Parse YYYY-MM-DD direkte for å unngå tidssone-forskyvning i browseren
            if (updateDate && updateDate.includes('-')) {
                const parts = updateDate.split('-');
                updateDate = `${parts[2]}.${parts[1]}.${parts[0]}`;
            }
            if (headingEl) headingEl.textContent = `Selskapsoppdatering (${updateDate})`;
            // Veldig enkel markdown parsing
            let html = data[0].news_summary
                .replace(/^### (.*$)/gim, '<h3>$1</h3>')
                .replace(/^## (.*$)/gim, '<h2>$1</h2>')
                .replace(/^\*\*([^*]+)\*\*/gim, '<strong>$1</strong>')
                .replace(/\n\n/g, '<br><br>');
            contentEl.innerHTML = html;
        } else {
            if (headingEl) headingEl.textContent = 'Selskapsoppdatering';
            contentEl.innerHTML = '<p>Ingen AI-analyse funnet for dette selskapet.</p>';
        }
    } catch(err) {
        console.error("Feil ved henting av analyse:", err);
    }
}

async function loadCommodityAnalysis() {
    try {
        const urlStr = `${SUPABASE_URL}/rest/v1/company_news_summary?company_id=in.(${encodeURIComponent('BZ=F')},${encodeURIComponent('NG=F')},${encodeURIComponent('TTF=F')},UREA_ME)&select=company_id,date,news_summary&order=date.desc&limit=20`;
        const res = await fetch(urlStr, { headers });
        if (!res.ok) throw new Error("Råvareanalyse feil: " + await res.text());
        const data = await res.json();
        
        const contentEl = document.getElementById('commodity-analysis-content');
        
        if (data.length > 0) {
            // Få siste dato for hver råvare
            const latest = {};
            data.forEach(item => {
                if (!latest[item.company_id]) latest[item.company_id] = item;
            });
            globalCommodityAnalysis = latest;
        }
    } catch(err) {
        console.error("Feil ved henting av råvareanalyse:", err);
    }
}

// ==========================================
// CHART.JS RENDERERS
// ==========================================

function filterDate(data, timeFilter = currentTimeFilter) {
    if (!data || data.length === 0) return [];
    
    const now = new Date();
    let startDate = new Date();

    if (timeFilter === '1M') {
        startDate.setMonth(now.getMonth() - 1);
    } else if (timeFilter === 'YTD') {
        startDate = new Date(now.getFullYear(), 0, 1);
    } else if (timeFilter === '1Y') {
        startDate.setFullYear(now.getFullYear() - 1);
    } else if (timeFilter === '3Y') {
        startDate.setFullYear(now.getFullYear() - 3);
    } else if (timeFilter === '5Y') {
        startDate.setFullYear(now.getFullYear() - 5);
    }

    const startStr = startDate.toISOString().split('T')[0];
    return data.filter(d => d.date >= startStr);
}

function formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return d.toLocaleDateString('no-NO', { day: 'numeric', month: 'short', year: '2-digit' });
}

function renderStockChart(data) {
    const ctx = document.getElementById('stockChart').getContext('2d');
    if(stockChartInstance) stockChartInstance.destroy();
    
    const overlay = document.getElementById('stockChart').parentElement.querySelector('.loading-overlay');
    if(overlay) overlay.remove();
    
    const recentData = filterDate(data); 

    stockChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: recentData.map(d => formatDate(d.date)),
            datasets: [{
                label: 'Aksjekurs',
                data: recentData.map(d => d.close_price),
                borderColor: '#38bdf8', 
                backgroundColor: 'rgba(56, 189, 248, 0.1)',
                borderWidth: 2,
                pointRadius: 0,
                pointHoverRadius: 4,
                fill: true,
                tension: 0.1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { intersect: false, mode: 'index' },
            plugins: { legend: { display: false }, tooltip: { padding: 10 } },
            scales: { x: { ticks: { maxTicksLimit: 8 } } }
        }
    });
}

function renderGasChart(hhData, ttfData) {
    const ctx = document.getElementById('gasChart').getContext('2d');
    if(gasChartInstance) gasChartInstance.destroy();
    
    const overlay = document.getElementById('gasChart').parentElement.querySelector('.loading-overlay');
    if(overlay) overlay.remove();
    
    const recentHH = filterDate(hhData);
    const recentTTF = filterDate(ttfData);

    // Samle alle unike datoer
    const datesSet = new Set();
    recentHH.forEach(d => datesSet.add(d.date));
    recentTTF.forEach(d => datesSet.add(d.date));
    
    // Sorter datoene kronologisk
    const sortedDates = Array.from(datesSet).sort();
    
    // Map data for raskt oppslag
    const hhMap = new Map(recentHH.map(d => [d.date, d.close_price]));
    const ttfMap = new Map(recentTTF.map(d => [d.date, d.close_price]));

    const hhMapped = sortedDates.map(d => hhMap.has(d) ? hhMap.get(d) : null);
    const ttfMapped = sortedDates.map(d => ttfMap.has(d) ? ttfMap.get(d) : null);

    gasChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: sortedDates.map(d => formatDate(d)),
            datasets: [
                {
                    label: 'Henry Hub',
                    data: hhMapped,
                    borderColor: '#22c55e', // Grønn
                    borderWidth: 2,
                    pointRadius: 0,
                    tension: 0.1,
                    spanGaps: true
                },
                {
                    label: 'TTF',
                    data: ttfMapped,
                    borderColor: '#f59e0b', // Oransje/Amber
                    borderWidth: 2,
                    pointRadius: 0,
                    tension: 0.1,
                    spanGaps: true
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { intersect: false, mode: 'index' },
            plugins: { legend: { position: 'top' }, tooltip: { padding: 10 } },
            scales: { x: { ticks: { maxTicksLimit: 8 } } }
        }
    });
}

function renderUreaChart(data) {
    const ctx = document.getElementById('ureaChart').getContext('2d');
    if(ureaChartInstance) ureaChartInstance.destroy();
    
    const overlay = document.getElementById('ureaChart').parentElement.querySelector('.loading-overlay');
    if(overlay) overlay.remove();
    
    const recentData = filterDate(data); 

    ureaChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: recentData.map(d => formatDate(d.date)),
            datasets: [{
                label: 'Urea',
                data: recentData.map(d => d.close_price),
                borderColor: '#c084fc', // Lilla
                backgroundColor: 'rgba(192, 132, 252, 0.1)',
                borderWidth: 2,
                pointRadius: 0,
                pointHoverRadius: 4,
                fill: true,
                tension: 0.1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { intersect: false, mode: 'index' },
            plugins: { legend: { display: false }, tooltip: { padding: 10 } },
            scales: { x: { ticks: { maxTicksLimit: 8 } } }
        }
    });
}

function renderOilChart(data) {
    const ctx = document.getElementById('oilChart').getContext('2d');
    if(oilChartInstance) oilChartInstance.destroy();
    
    const overlay = document.getElementById('oilChart').parentElement.querySelector('.loading-overlay');
    if(overlay) overlay.remove();
    
    const recentData = filterDate(data); 

    oilChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: recentData.map(d => formatDate(d.date)),
            datasets: [{
                label: 'Brent Crude (USD/fat)',
                data: recentData.map(d => d.close_price),
                borderColor: '#eab308', // yellow/gold
                backgroundColor: 'rgba(234, 179, 8, 0.1)',
                borderWidth: 2,
                pointRadius: 0,
                pointHoverRadius: 4,
                fill: true,
                tension: 0.1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { intersect: false, mode: 'index' },
            plugins: { legend: { display: false }, tooltip: { padding: 10 } },
            scales: { x: { ticks: { maxTicksLimit: 8 } } }
        }
    });
}

// ==========================================
// FINANSIELL DATA & SELSKAPS INFO
// ==========================================
let currentFinancialDataMap = {};
let currentlyEditingId = null;
let currentlyEditingOldVal = null;

async function loadCompanyFinancials(ticker) {
    const btn = document.getElementById('btn-company-info');
    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/company_financial_data?company_id=eq.${ticker}&select=*`, { headers });
        if (!res.ok) throw new Error("Feil ved henting av finansiell data");
        const data = await res.json();
        
        currentFinancialDataMap = {};
        if (data && data.length > 0) {
            btn.style.display = 'block';
            data.forEach(d => currentFinancialDataMap[d.id] = d);
            renderFinancialTable(data);
        } else {
            btn.style.display = 'none';
            document.getElementById('financial-table').innerHTML = '<tr><td>Ingen data funnet for dette selskapet.</td></tr>';
        }
    } catch (err) {
        console.error("Feil i loadCompanyFinancials:", err);
        btn.style.display = 'none';
    }
}

function renderFinancialTable(data) {
    const table = document.getElementById('financial-table');
    
    // Finn unike år og sorter dem synkende (f.eks 2025, 2024)
    const years = [...new Set(data.map(d => d.aar))].sort((a, b) => b - a);
    
    // Grupper dataene
    // Struktur: groups[gruppe][kategori][aar] = verdi
    const groups = {};
    data.forEach(row => {
        if (!groups[row.gruppe]) groups[row.gruppe] = {};
        if (!groups[row.gruppe][row.kategori]) groups[row.gruppe][row.kategori] = {};
        groups[row.gruppe][row.kategori][row.aar] = row;
    });

    // Sortere grupper
    const groupOrder = ["Resultatregnskap (mill. kroner)", "Balanse", "Verdier og utbytte", "Finansielle nøkkeltall", "Andre nøkkeltall", "Klimagassutslipp"];
    const existingGroups = Object.keys(groups);
    const sortedGroups = groupOrder.filter(g => existingGroups.includes(g));
    existingGroups.forEach(g => {
        if (!sortedGroups.includes(g)) sortedGroups.push(g);
    });

    let html = '';
    
    // Header rad (år)
    html += '<tr class="table-header-row"><th>Kategori</th>';
    years.forEach(y => {
        html += `<th>${y}</th>`;
    });
    html += '</tr>';

    // Data rader
    sortedGroups.forEach(gruppe => {
        // Gruppeoverskrift
        html += `<tr class="table-group-row"><td colspan="${years.length + 1}">${gruppe}</td></tr>`;
        
        // Kategorier
        const categories = Object.keys(groups[gruppe]);
        categories.forEach(kategori => {
            html += `<tr class="table-data-row"><td>${kategori}</td>`;
            years.forEach(y => {
                let rowData = groups[gruppe][kategori][y];
                if (rowData !== undefined && rowData !== null) {
                    let val = rowData.verdi;
                    let formattedVal = typeof val === 'number' ? val.toLocaleString('no-NB') : val;
                    html += `<td class="editable-cell" onclick="openEditModal(${rowData.id})" title="Klikk for å redigere">${formattedVal}</td>`;
                } else {
                    html += `<td>-</td>`;
                }
            });
            html += '</tr>';
        });
    });

    table.innerHTML = html;
}

async function openEditModal(id) {
    const row = currentFinancialDataMap[id];
    if (!row) return;
    
    currentlyEditingId = id;
    currentlyEditingOldVal = row.verdi;
    
    document.getElementById('edit-modal-context').textContent = `${row.selskap} | ${row.kategori} | ${row.aar}`;
    
    let formattedVal = typeof row.verdi === 'number' ? row.verdi.toLocaleString('no-NB') : row.verdi;
    document.getElementById('edit-modal-current-val').textContent = formattedVal !== null ? formattedVal : '-';
    
    document.getElementById('edit-modal-input').value = row.verdi !== null ? row.verdi : '';
    document.getElementById('edit-modal-merknad').value = row.merknad || '';
    document.getElementById('edit-modal-kommentar').value = '';
    document.getElementById('edit-modal-error').style.display = 'none';
    
    // Sett loading state for historikk
    const historyContainer = document.getElementById('edit-modal-history');
    historyContainer.innerHTML = '<div class="loading-spinner"></div>';
    
    document.getElementById('edit-modal').style.display = 'flex';
    
    // Hent historikk
    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/financial_data_audit?financial_data_id=eq.${id}&order=changed_at.desc`, {
            headers: headers
        });
        if (res.ok) {
            const historyData = await res.json();
            if (historyData.length === 0) {
                historyContainer.innerHTML = '<p style="color: var(--text-secondary); margin: 0;">Ingen tidligere endringer.</p>';
            } else {
                let html = '<ul style="list-style-type: none; padding: 0; margin: 0;">';
                historyData.forEach(entry => {
                    const dateObj = new Date(entry.changed_at);
                    const dateStr = dateObj.toLocaleDateString('no-NB') + ' ' + dateObj.toLocaleTimeString('no-NB', {hour: '2-digit', minute:'2-digit'});
                    
                    const oldV = entry.old_verdi !== null ? entry.old_verdi : '-';
                    const newV = entry.new_verdi !== null ? entry.new_verdi : '-';
                    
                    html += `
                        <li style="margin-bottom: 0.75rem; padding-bottom: 0.75rem; border-bottom: 1px solid rgba(255,255,255,0.05);">
                            <div style="display: flex; justify-content: space-between; margin-bottom: 0.25rem;">
                                <strong style="color: var(--accent);">${entry.changed_by}</strong>
                                <span style="color: var(--text-secondary); font-size: 0.75rem;">${dateStr}</span>
                            </div>
                            <div style="margin-bottom: 0.25rem;">
                                Endret fra <strong>${oldV}</strong> til <strong>${newV}</strong>
                            </div>
                            <div style="color: var(--text-secondary); font-style: italic;">
                                "${entry.kommentar}"
                            </div>
                        </li>
                    `;
                });
                html += '</ul>';
                historyContainer.innerHTML = html;
            }
        } else {
            historyContainer.innerHTML = '<p style="color: #fca5a5; margin: 0;">Kunne ikke laste historikk.</p>';
        }
    } catch (err) {
        historyContainer.innerHTML = '<p style="color: #fca5a5; margin: 0;">Feil ved henting av historikk.</p>';
    }
}

function closeEditModal() {
    document.getElementById('edit-modal').style.display = 'none';
    currentlyEditingId = null;
}

async function saveFinancialData() {
    if (!currentlyEditingId) return;
    
    const newVal = document.getElementById('edit-modal-input').value;
    const newMerknad = document.getElementById('edit-modal-merknad').value;
    const newKommentar = document.getElementById('edit-modal-kommentar').value.trim();
    
    // Valider kommentar
    if (!newKommentar) {
        document.getElementById('edit-modal-error').style.display = 'block';
        return;
    } else {
        document.getElementById('edit-modal-error').style.display = 'none';
    }
    
    // Konverter til float eller null
    const verdiToSave = newVal === '' ? null : parseFloat(newVal);
    
    try {
        // Hent innlogget bruker
        const { data: { user } } = await supabaseClient.auth.getUser();
        const userEmail = user ? user.email : 'ukjent';

        const patchHeaders = { ...headers, "Content-Type": "application/json", "Prefer": "return=minimal" };
        
        // 1. Oppdater selve tabellen
        const res = await fetch(`${SUPABASE_URL}/rest/v1/company_financial_data?id=eq.${currentlyEditingId}`, {
            method: 'PATCH',
            headers: patchHeaders,
            body: JSON.stringify({ verdi: verdiToSave, merknad: newMerknad })
        });
        
        if (!res.ok) throw new Error("Kunne ikke lagre data. Status: " + res.status);
        
        // 2. Lagre loggføring (audit trail)
        const auditRes = await fetch(`${SUPABASE_URL}/rest/v1/financial_data_audit`, {
            method: 'POST',
            headers: patchHeaders,
            body: JSON.stringify({
                financial_data_id: currentlyEditingId,
                old_verdi: currentlyEditingOldVal,
                new_verdi: verdiToSave,
                changed_by: userEmail,
                kommentar: newKommentar
            })
        });
        
        if (!auditRes.ok) console.error("Kunne ikke lagre sporingslogg. Status:", auditRes.status);
        
        // Oppdatering var vellykket
        closeEditModal();
        
        // Last data på nytt for å tegne tabellen oppdatert
        await loadCompanyFinancials(document.getElementById('companySelect').value);
        
    } catch (err) {
        console.error("Feil ved lagring:", err);
        alert("En feil oppstod ved lagring: " + err.message);
    }
}

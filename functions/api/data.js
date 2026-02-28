const GAMMA_API_URL = "https://gamma-api.polymarket.com";
const CLOB_API_URL = "https://clob.polymarket.com";

const THUNDER_KEYWORDS = [
    'deepseek', 'ai', 'nvidia', 'gpu', 'openai', 'gpt', 'anthropic', 'claude',
    'apple intelligence', 'siri', 'bitcoin', 'btc', 'eth'
];

function getPrice(market) {
    const ps = market.outcomePrices;
    if (ps) {
        try {
            const pList = JSON.parse(ps);
            if (pList && pList.length > 0) return parseFloat(pList[0]);
        } catch { }
    }
    return null;
}

async function getHistoricalPriceDelta(market) {
    const tokens = market.tokens || [];
    if (!tokens.length) return 0;
    const tokenId = tokens[0].token_id;
    const currentPrice = getPrice(market);
    if (currentPrice === null) return 0;
    try {
        const targetTs = Math.floor(Date.now() / 1000) - 86400;
        const params = new URLSearchParams({
            market: tokenId, interval: "1h",
            start: targetTs.toString(), end: (targetTs + 3600).toString()
        });
        const res = await fetch(`${CLOB_API_URL}/prices-history?${params}`, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(2000)
        });
        if (res.ok) {
            const data = await res.json();
            const history = data.history || [];
            if (history.length > 0) {
                const oldPrice = parseFloat(history[0].p || currentPrice);
                return currentPrice - oldPrice;
            }
        }
    } catch { }
    return 0;
}

async function fetchOracleData(userQuery = '') {
    try {
        const headers = { 'User-Agent': 'Mozilla/5.0' };
        let marketsList = [];

        if (userQuery) {
            // Try official public search first
            try {
                const searchParams = new URLSearchParams({ q: userQuery, active: "true" });
                const searchRes = await fetch(`${GAMMA_API_URL}/public-search?${searchParams}`, {
                    headers, signal: AbortSignal.timeout(5000)
                });
                if (searchRes.ok) {
                    const respData = await searchRes.json();
                    // /public-search returns {"events": [...]} with nested markets
                    for (const event of (respData.events || [])) {
                        marketsList.push(...(event.markets || []));
                    }
                } else {
                    throw new Error(`Search returned HTTP ${searchRes.status}`);
                }
            } catch {
                // FALLBACK: Local filtering from top 500 markets
                try {
                    const fallbackParams = new URLSearchParams({
                        active: "true", closed: "false", limit: "500", order: "volume", ascending: "false"
                    });
                    const res = await fetch(`${GAMMA_API_URL}/markets?${fallbackParams}`, {
                        headers, signal: AbortSignal.timeout(5000)
                    });
                    const fullPool = await res.json();
                    const qParts = userQuery.toLowerCase().split(/\s+/);
                    marketsList = fullPool.filter(m => {
                        const text = ((m.question || '') + (m.description || '')).toLowerCase();
                        return qParts.every(p => text.includes(p));
                    });
                } catch { }
            }
        } else {
            // Default Landing Page
            const defaultParams = new URLSearchParams({
                active: "true", closed: "false", limit: "300", order: "volume", ascending: "false"
            });
            const res = await fetch(`${GAMMA_API_URL}/markets?${defaultParams}`, {
                headers, signal: AbortSignal.timeout(5000)
            });
            marketsList = await res.json();
        }

        // Process markets
        const relevantData = [];
        for (const m of marketsList) {
            if (!userQuery) {
                const combinedText = ((m.question || '') + ' ' + (m.description || '')).toLowerCase();
                if (!THUNDER_KEYWORDS.some(key => combinedText.includes(key))) continue;
            }
            const currentP = getPrice(m);
            if (currentP === null) continue;
            m.current_prob = currentP * 100;
            m.delta_24h = (await getHistoricalPriceDelta(m)) * 100;
            relevantData.push(m);
        }

        // Split categories
        let aiFocus = relevantData.filter(m =>
            ['ai', 'seek', 'gpt', 'model', 'apple', 'nvidia'].some(k => (m.question || '').toLowerCase().includes(k))
        );
        if (userQuery && aiFocus.length === 0) {
            aiFocus = relevantData.slice(0, 10);
        } else {
            aiFocus = aiFocus.sort((a, b) => parseFloat(b.volume || 0) - parseFloat(a.volume || 0)).slice(0, 10);
        }

        let criticalAlerts = relevantData
            .filter(m => m.current_prob < 15 || m.current_prob > 85)
            .sort((a, b) => parseFloat(b.volume || 0) - parseFloat(a.volume || 0))
            .slice(0, 10);

        let topMovers = [...relevantData]
            .sort((a, b) => Math.abs(b.delta_24h) - Math.abs(a.delta_24h))
            .slice(0, 10);

        return {
            ai_focus: aiFocus,
            critical_alerts: criticalAlerts,
            top_movers: topMovers,
            last_update: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
            is_search: Boolean(userQuery)
        };
    } catch (e) {
        return { error: String(e) };
    }
}

export async function onRequestGet(context) {
    const url = new URL(context.request.url);
    const q = url.searchParams.get('q') || '';
    const data = await fetchOracleData(q);

    return new Response(JSON.stringify(data), {
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        }
    });
}

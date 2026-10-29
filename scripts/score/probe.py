"""Fase 0 da engenharia reversa do copyScore: procura pistas no site e na API da Hyperdash.

Baixa o bundle JS do site, extrai as queries GraphQL e os trechos que falam de score,
roda as queries ainda não testadas num trader do Top 100 e sonda campos escondidos
pelas sugestões de erro do GraphQL ("Did you mean ...").

Uso: python3 probe.py [pasta_saida]
"""
import json
import os
import re
import sys
import time

import requests

SITE = "https://hyperdash.com"
API = "https://api.hyperdash.com/graphql"
HEADERS = {"Origin": SITE, "User-Agent": "Mozilla/5.0"}
KEYWORDS = ["copyScore", "copy score", "Copy Score", "CopyScore", "scoreV2", "copyScoreV2"]
# Nomes plausíveis de campos que a API pode ter e não expõe no site.
GUESSES = [
    "score", "scoreV3", "copyScoreV3", "copyScoreBreakdown", "copyScoreComponents", "copyScoreDetails",
    "scoreBreakdown", "scoreComponents", "stats", "metrics", "sortino", "calmar", "profitFactor",
    "consistency", "avgHoldTime", "avgHoldingTime", "maxLeverage", "avgLeverage", "roi", "returns",
    "volatility", "volume", "totalVolume", "accountAge", "firstTradeAt", "riskScore", "pnlScore",
    "consistencyScore", "riskAdjustedReturn", "maxDrawdown", "winrate30d", "sharpe30d", "pnl30d",
]


def gql(query, variables=None):
    r = requests.post(API, json={"query": query, "variables": variables or {}}, headers=HEADERS, timeout=60)
    time.sleep(0.5)
    try:
        return r.json()
    except ValueError:
        return {"status": r.status_code, "text": r.text[:2000]}


def fetch_bundle(out):
    html = requests.get(SITE, headers=HEADERS, timeout=60).text
    pending = set(re.findall(r'["\'(](/?assets/[^"\'()\s]+\.js)', html))
    seen, texts = set(), {}
    while pending:
        path = "/" + pending.pop().lstrip("/")
        if path in seen:
            continue
        seen.add(path)
        r = requests.get(SITE + path, headers=HEADERS, timeout=60)
        if r.status_code != 200:
            continue
        texts[path] = r.text
        # Chunks carregados sob demanda aparecem como "assets/xxx.js" ou "./xxx.js" dentro do bundle.
        for m in re.findall(r'["\'`](?:\.?/)?(assets/[\w.-]+\.js)', r.text):
            pending.add(m)
        for m in re.findall(r'["\'`]\./([\w.-]+\.js)["\'`]', r.text):
            pending.add("assets/" + m)
    os.makedirs(f"{out}/bundle", exist_ok=True)
    for path, text in texts.items():
        with open(f"{out}/bundle/{os.path.basename(path)}", "w") as f:
            f.write(text)
    print(f"bundle: {len(texts)} arquivos JS, {sum(map(len, texts.values())) // 1024} KB")
    return texts


def extract_queries(texts, out):
    docs = {}
    for text in texts.values():
        for m in re.finditer(r'(?:query|fragment|mutation|subscription)\s+(\w+)[^`]*?\{', text):
            # Pega até fechar as chaves do documento.
            start, depth, i = m.start(), 0, m.end() - 1
            while i < len(text):
                if text[i] == "{":
                    depth += 1
                elif text[i] == "}":
                    depth -= 1
                    if depth == 0:
                        break
                i += 1
            body = text[start:i + 1].replace("\\n", "\n")
            if len(body) < 20000:
                docs.setdefault(m.group(1), body)
    with open(f"{out}/queries.graphql", "w") as f:
        for name, body in sorted(docs.items()):
            f.write(f"# {name}\n{body}\n\n")
    print(f"queries GraphQL: {len(docs)} -> {', '.join(sorted(docs))}")
    return docs


def keyword_snippets(texts, out):
    seen, snippets = set(), []
    for path, text in texts.items():
        for kw in KEYWORDS:
            for m in re.finditer(re.escape(kw), text):
                a, b = max(0, m.start() - 400), min(len(text), m.end() + 400)
                key = text[a:b]
                if key in seen:
                    continue
                seen.add(key)
                snippets.append(f"== {os.path.basename(path)} @{m.start()} [{kw}]\n{key}\n")
    with open(f"{out}/snippets.txt", "w") as f:
        f.write("\n".join(snippets))
    print(f"trechos com palavras-chave: {len(snippets)}")


def top_trader():
    q = "query($g: ID!) { getSystemGroupTraders(groupId: $g) { address copyScore: copyScoreV2 } }"
    rows = gql(q, {"g": "copytraders"})["data"]["getSystemGroupTraders"]
    return max(rows, key=lambda t: t["copyScore"] or 0)["address"]


def run_queries(docs, address, out):
    results = {}
    for name, body in docs.items():
        if not body.startswith("query") or "$address" not in body:
            continue
        variables = {"address": address, "addresses": [address], "timeframe": "thirty_days",
                     "page": 1, "pageSize": 20, "limit": 20}
        # Só manda as variáveis que a query declara.
        declared = set(re.findall(r'\$(\w+)\s*:', body))
        frags = "".join(b for n, b in docs.items() if b.startswith("fragment") and f"...{n}" in body)
        results[name] = gql(body + "\n" + frags, {k: v for k, v in variables.items() if k in declared})
    with open(f"{out}/query_results.json", "w") as f:
        json.dump(results, f, indent=1)
    for name, res in results.items():
        status = "erro: " + res["errors"][0].get("message", "")[:150] if res.get("errors") else "ok"
        print(f"  {name}: {status}")


def probe_fields(address, out):
    found = {}
    for field in GUESSES:
        res = gql(f'query($a: String!) {{ getTrader(address: $a, includePortfolioGraph: false) {{ {field} }} }}',
                  {"a": address})
        found[field] = res
        msg = res["errors"][0]["message"] if res.get("errors") else "EXISTE: " + json.dumps(res.get("data"))[:300]
        print(f"  {field}: {msg[:300]}")
    # Erros de tipo também revelam nomes de argumentos e de tipos.
    for extra in ['{ getTrader(address: $a, foo: 1) { address } }', '{ getTrader(address: $a) { copyScoreV2 { x } } }',
                  '{ getTraderScore(address: $a) }', '{ getCopyScore(address: $a) }']:
        res = gql("query($a: String!) " + extra, {"a": address})
        found[extra] = res
        print(f"  {extra}: {json.dumps(res)[:300]}")
    with open(f"{out}/field_probe.json", "w") as f:
        json.dump(found, f, indent=1)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "probe_out"
    os.makedirs(out, exist_ok=True)
    texts = fetch_bundle(out)
    docs = extract_queries(texts, out)
    keyword_snippets(texts, out)
    address = top_trader()
    print(f"trader de teste: {address}")
    print("queries com $address:")
    run_queries(docs, address, out)
    print("sondagem de campos em getTrader:")
    probe_fields(address, out)


if __name__ == "__main__":
    main()

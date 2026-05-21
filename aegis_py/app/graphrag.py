"""GraphRAG подсистема (Neo4j + NetworkX).

Все тяжёлые deps — опциональные. Если neo4j/networkx не установлены,
is_available() возвращает False и main.py возвращает 503.

Env:
    AEGIS_NEO4J_URI (например, bolt://neo4j:7687)
    AEGIS_NEO4J_USER (default neo4j)
    AEGIS_NEO4J_PASSWORD
"""

import os
from typing import Any, Dict, List, Optional

_REASON = None
try:  # pragma: no cover (heavy deps)
    from neo4j import GraphDatabase  # type: ignore
    import networkx as nx  # type: ignore
    _DEPS_OK = True
except Exception as e:  # pragma: no cover
    GraphDatabase = None  # type: ignore
    nx = None  # type: ignore
    _DEPS_OK = False
    _REASON = f"deps_missing: {e.__class__.__name__}"


def _uri() -> str:
    return os.environ.get("AEGIS_NEO4J_URI", "").strip()


def is_available() -> bool:
    return _DEPS_OK and bool(_uri())


def unavailable_reason() -> Optional[str]:
    if not _DEPS_OK:
        return _REASON
    if not _uri():
        return "AEGIS_NEO4J_URI not set"
    return None


def _driver():
    return GraphDatabase.driver(  # type: ignore[union-attr]
        _uri(),
        auth=(os.environ.get("AEGIS_NEO4J_USER", "neo4j"),
              os.environ.get("AEGIS_NEO4J_PASSWORD", "")),
    )


def upsert(niche: str, entities: List[Dict[str, Any]], intents: List[Dict[str, Any]],
           facts: List[Dict[str, Any]], article_id: Optional[str]) -> Dict[str, Any]:
    """Записывает узлы (Entity/Intent/CompetitorFact/Article) и связи
    (COVERS_INTENT/PROVES_FACT/RELATES_TO) в Neo4j. Идемпотентно: MERGE по
    name/label/hash. Возвращает счётчики затронутых узлов."""
    counts = {"entities": 0, "intents": 0, "facts": 0, "articles": 0}
    with _driver() as drv, drv.session() as s:
        for e in entities:
            s.run(
                "MERGE (n:Entity {name: $name, niche: $niche}) "
                "SET n.weight = coalesce($weight, n.weight)",
                name=e.get("name"), niche=niche, weight=e.get("weight"),
            )
            counts["entities"] += 1
        for i in intents:
            s.run(
                "MERGE (n:Intent {label: $label, niche: $niche})",
                label=i.get("label"), niche=niche,
            )
            counts["intents"] += 1
        for f in facts:
            s.run(
                "MERGE (n:CompetitorFact {hash: $hash}) "
                "SET n.text = $text, n.source_url = $url, n.numeric = $numeric",
                hash=f.get("hash"), text=f.get("text"), url=f.get("source_url"),
                numeric=f.get("numeric"),
            )
            counts["facts"] += 1
        if article_id:
            s.run(
                "MERGE (a:Article {id: $id, niche: $niche})",
                id=article_id, niche=niche,
            )
            counts["articles"] += 1
    return {"counts": counts, "niche": niche}


def retrieve_top_lsi(niche: str, query: str, top_k: int) -> List[Dict[str, Any]]:
    """Возвращает top-K Entity/Intent по Betweenness Centrality.

    1) Тянем подграф ниши из Neo4j (узлы + рёбра).
    2) Строим nx.Graph, считаем nx.betweenness_centrality.
    3) Сортируем по убыванию score и возвращаем top-K.
    """
    G = nx.Graph()  # type: ignore[union-attr]
    with _driver() as drv, drv.session() as s:
        nodes = s.run(
            "MATCH (n) WHERE n.niche = $niche AND (n:Entity OR n:Intent) "
            "RETURN id(n) AS id, labels(n) AS labels, n.name AS name, n.label AS label",
            niche=niche,
        ).data()
        edges = s.run(
            "MATCH (a)-[r]-(b) WHERE a.niche = $niche AND b.niche = $niche "
            "RETURN id(a) AS s, id(b) AS t",
            niche=niche,
        ).data()
    name_by_id = {}
    for n in nodes:
        nm = n.get("name") or n.get("label")
        name_by_id[n["id"]] = nm
        G.add_node(n["id"], name=nm, labels=n["labels"])
    for e in edges:
        G.add_edge(e["s"], e["t"])
    if G.number_of_nodes() == 0:
        return []
    bc = nx.betweenness_centrality(G)  # type: ignore[union-attr]
    ranked = sorted(bc.items(), key=lambda kv: kv[1], reverse=True)[:top_k]
    return [
        {"name": name_by_id.get(nid), "score": round(score, 4)}
        for nid, score in ranked
        if name_by_id.get(nid)
    ]

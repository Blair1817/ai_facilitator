"""
Feature Server — Python sidecar for callbacks.js

Computes all five discussion features using the same logic as
DetectorCalib/src/2_compute_features.py, ensuring consistency
between calibration and the live experiment system.

Run this alongside the Empirica server:
    python server/src/feature_server.py

Listens on http://localhost:5001
callbacks.js sends POST /features with the last 6 human messages.

Dependencies:
    pip install flask sentence-transformers numpy
"""

from flask import Flask, request, jsonify
from sentence_transformers import SentenceTransformer
from itertools import combinations
import numpy as np

app = Flask(__name__)

# Load model once at startup — same model as DetectorCalib
MODEL_NAME = "all-MiniLM-L6-v2"
print(f"[FeatureServer] Loading embedding model: {MODEL_NAME}...")
model = SentenceTransformer(MODEL_NAME)
print("[FeatureServer] Model ready.")

# ── Lexicons (must match config.py in DetectorCalib) ──────────────────────────

AGREEMENT_EXPRESSIONS = [
    "i agree", "i think so too", "that's right", "that is right",
    "exactly", "absolutely", "definitely", "of course", "certainly",
    "yes", "yeah", "yep", "yup", "correct", "true", "right",
    "good point", "makes sense", "that makes sense", "sounds good",
    "sounds right", "fair enough", "agreed", "totally agree",
    "same here", "me too", "same", "i also think", "i also feel",
]

REASONING_MARKERS = [
    "because", "since", "as a result", "due to", "owing to",
    "therefore", "thus", "hence", "so", "consequently",
    "according to", "based on", "the data", "it says", "it shows",
    "the information", "it mentions", "it states",
    "for example", "for instance", "such as", "the reason",
    "this means", "this suggests", "this indicates", "this shows",
    "compared to", "in comparison", "on the other hand",
    "however", "but", "although", "even though",
    "while", "whereas", "unlike", "despite",
    "the pros", "the cons", "the advantage", "the disadvantage",
    "outweigh", "better than", "worse than",
]


# ── Feature functions (identical to 2_compute_features.py) ────────────────────

def compute_gini(values):
    if not values or sum(values) == 0:
        return 0.0
    values = sorted(values)
    n = len(values)
    weighted_sum = sum((i + 1) * v for i, v in enumerate(values))
    return (2 * weighted_sum) / (n * sum(values)) - (n + 1) / n


def compute_participation_balance(messages):
    """
    Gini coefficient of word count per sender.
    Higher = more imbalanced participation.
    """
    word_counts = {}
    for m in messages:
        sender = m["sender"]
        word_counts[sender] = word_counts.get(sender, 0) + len(m["text"].split())
    if len(word_counts) < 2:
        return 0.0
    return round(compute_gini(list(word_counts.values())), 4)


def compute_semantic_features(messages, redundancy_threshold=0.85):
    """
    Compute Semantic Novelty and Semantic Redundancy from one embedding call.

    Semantic Novelty:
        1 - mean pairwise cosine similarity across ALL message pairs.
        Low novelty = discussion is semantically repetitive overall.

    Semantic Redundancy:
        For each message i (index >= 1), check whether cosine similarity
        to ANY prior message j < i exceeds redundancy_threshold.
        Binary per message. redundancy_score = redundant / (n - 1)
        High redundancy = discussion is going in circles.
    """
    texts = [m["text"] for m in messages]

    if len(texts) < 2:
        return 1.0, 0.0

    embeddings = model.encode(texts, normalize_embeddings=True, show_progress_bar=False)
    n = len(embeddings)

    # Novelty: all pairs
    all_sims = [
        float(np.dot(embeddings[i], embeddings[j]))
        for i, j in combinations(range(n), 2)
    ]
    novelty_score = 1.0 - float(np.mean(all_sims))

    # Redundancy: each message vs prior messages only
    redundant = 0
    for i in range(1, n):
        for j in range(i):
            if float(np.dot(embeddings[i], embeddings[j])) > redundancy_threshold:
                redundant += 1
                break

    redundancy_score = redundant / (n - 1)

    return round(novelty_score, 4), round(redundancy_score, 4)


def compute_agreement_density(messages):
    """
    Proportion of messages containing at least one agreement expression.
    """
    if not messages:
        return 0.0
    count = sum(
        1 for m in messages
        if any(expr in m["text"].lower() for expr in AGREEMENT_EXPRESSIONS)
    )
    return round(count / len(messages), 4)


def compute_justification_ratio(messages):
    """
    Proportion of messages containing at least one reasoning marker.
    """
    if not messages:
        return 0.0
    count = sum(
        1 for m in messages
        if any(marker in m["text"].lower() for marker in REASONING_MARKERS)
    )
    return round(count / len(messages), 4)


# ── Route ──────────────────────────────────────────────────────────────────────

@app.route("/features", methods=["POST"])
def compute_features():
    """
    POST /features

    Request body:
    {
        "messages": [
            { "sender": "Red",  "text": "I think Eldoron is best" },
            { "sender": "Pink", "text": "Yeah I agree" },
            ...
        ],
        "redundancy_threshold": 0.85  // optional, defaults to 0.85
    }

    Response:
    {
        "gini_score":          0.123,
        "novelty_score":       0.751,
        "redundancy_score":    0.040,
        "agreement_score":     0.167,
        "justification_score": 0.333
    }
    """
    try:
        body = request.get_json()
        messages             = body.get("messages", [])
        redundancy_threshold = body.get("redundancy_threshold", 0.85)

        if not messages:
            return jsonify({
                "gini_score":          0.0,
                "novelty_score":       1.0,
                "redundancy_score":    0.0,
                "agreement_score":     0.0,
                "justification_score": 0.0
            })

        gini          = compute_participation_balance(messages)
        novelty, redundancy = compute_semantic_features(messages, redundancy_threshold)
        agreement     = compute_agreement_density(messages)
        justification = compute_justification_ratio(messages)

        return jsonify({
            "gini_score":          gini,
            "novelty_score":       novelty,
            "redundancy_score":    redundancy,
            "agreement_score":     agreement,
            "justification_score": justification
        })

    except Exception as e:
        print(f"[FeatureServer] Error: {e}")
        return jsonify({ "error": str(e) }), 500


@app.route("/health", methods=["GET"])
def health():
    """Quick health check — callbacks.js can call this on startup."""
    return jsonify({ "status": "ok", "model": MODEL_NAME })


if __name__ == "__main__":
    print("[FeatureServer] Starting on http://localhost:5001")
    app.run(port=5001, debug=False)
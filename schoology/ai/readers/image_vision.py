"""Image object detection via CLIP (open_clip).

Best effort: if open_clip or its model weights aren't available, this
returns None so the caller can silently skip and fall back to OCR.
On the 512MB Fly machine, the first call downloads the model (~150MB
for ViT-B-32) -- this is a one-time cost.
"""

from pathlib import Path


def read(path: Path, top_k: int = 8) -> list | None:
    try:
        import open_clip
        import torch
        from PIL import Image
    except Exception:
        return None
    try:
        # Lazy init: cache the model on the module so we only download once.
        global _model, _preprocess, _tokenizer, _labels
        if _model is None:
            model, _, preprocess = open_clip.create_model_and_transforms(
                "ViT-B-32", pretrained="laion2b_s34b_b79k"
            )
            tokenizer = open_clip.get_tokenizer("ViT-B-32")
            _model = model
            _preprocess = preprocess
            _tokenizer = tokenizer
            _labels = _CANDIDATE_LABELS
        img = Image.open(str(path)).convert("RGB")
        image_input = _preprocess(img).unsqueeze(0)
        text_tokens = _tokenizer(_labels)
        with torch.no_grad():
            image_features = _model.encode_image(image_input)
            text_features = _model.encode_text(text_tokens)
            # Cosine similarity, scaled to probs.
            image_features /= image_features.norm(dim=-1, keepdim=True)
            text_features /= text_features.norm(dim=-1, keepdim=True)
            probs = (100.0 * image_features @ text_features.T).softmax(dim=-1)
        top = probs[0].topk(top_k)
        return [
            {"label": _labels[i], "confidence": float(p) / 100.0}
            for p, i in zip(top.values.tolist(), top.indices.tolist())
        ]
    except Exception:
        return None


_model = None
_preprocess = None
_tokenizer = None
_labels = None


# A modest set of object categories suited to study / general images. CLIP
# zero-shot is best on natural categories, not on arbitrary vocab.
_CANDIDATE_LABELS = [
    "a photo of a cat", "a photo of a dog", "a photo of a bird",
    "a photo of a person", "a photo of a car", "a photo of a tree",
    "a photo of a building", "a photo of food", "a photo of a book",
    "a photo of a phone", "a photo of a computer", "a photo of a plant",
    "a photo of an animal", "a photo of furniture", "a photo of an artwork",
    "a photo of a chart or graph", "a photo of a diagram",
    "a photo of a handwritten note", "a photo of a printed page",
    "a photo of a math equation", "a photo of a periodic table",
    "a photo of a chemical structure", "a photo of a map",
    "a photo of a piece of paper", "a photo of a screenshot",
    "a photo of a landscape", "a photo of a city", "a photo of a sunset",
    "a screenshot of code", "a screenshot of a chat message",
]

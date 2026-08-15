"""Line-delimited JSON worker for local rembg CPU inference.

The Node process owns all paths and sends one request at a time. The u2netp
session is loaded once and reused until the worker is idled out.
"""

from __future__ import annotations

import io
import json
import os
import sys
from pathlib import Path

import numpy as np
import scipy.ndimage as ndimage
from PIL import Image
from rembg import new_session, remove


MODEL = os.environ.get("BACKGROUND_REMOVAL_MODEL", "u2netp")
SESSION = new_session(MODEL)


def respond(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def post_process_alpha(rgba_bytes: bytes) -> bytes:
    """Filter out disconnected corner/margin artifacts and floating noise from the alpha mask."""
    try:
        img = Image.open(io.BytesIO(rgba_bytes))
        arr = np.array(img)
        if arr.ndim != 3 or arr.shape[2] != 4:
            return rgba_bytes

        alpha = arr[:, :, 3]
        h, w = alpha.shape
        binary = alpha > 15
        if not binary.any():
            return rgba_bytes

        labeled_array, num_features = ndimage.label(binary)
        if num_features <= 1:
            return rgba_bytes

        component_sizes = ndimage.sum(binary, labeled_array, range(1, num_features + 1))
        max_size = component_sizes.max()
        slices = ndimage.find_objects(labeled_array)

        cleaned_alpha = alpha.copy()
        removed_any = False

        for i, slc in enumerate(slices, start=1):
            if slc is None:
                continue
            size = component_sizes[i - 1]
            y_slice, x_slice = slc

            y_min, y_max = y_slice.start, y_slice.stop
            x_min, x_max = x_slice.start, x_slice.stop

            # A component is a main product body if it reaches into the central zone
            # of the image (X: 15%..85%, Y: 15%..85%) AND has a meaningful size
            # (at least 3% of the largest component).
            reaches_center_x = (x_min < w * 0.85) and (x_max > w * 0.15)
            reaches_center_y = (y_min < h * 0.85) and (y_max > h * 0.15)
            reaches_center = reaches_center_x and reaches_center_y

            is_main = reaches_center and (size >= max_size * 0.03)

            if not is_main:
                cleaned_alpha[labeled_array == i] = 0
                removed_any = True

        if not removed_any:
            return rgba_bytes

        arr[:, :, 3] = cleaned_alpha
        output_buffer = io.BytesIO()
        Image.fromarray(arr).save(output_buffer, format="PNG")
        return output_buffer.getvalue()
    except Exception:
        return rgba_bytes


respond({"type": "ready", "model": MODEL})

for raw_line in sys.stdin:
    raw_line = raw_line.strip()
    if not raw_line:
        continue

    request_id = None
    try:
        request = json.loads(raw_line)
        request_id = request.get("id")
        input_path = Path(request["input"])
        output_path = Path(request["output"])
        output_path.parent.mkdir(parents=True, exist_ok=True)

        output_bytes = remove(input_path.read_bytes(), session=SESSION, force_return_bytes=True)
        cleaned_bytes = post_process_alpha(output_bytes)

        temporary_path = output_path.with_suffix(f"{output_path.suffix}.tmp")
        temporary_path.write_bytes(cleaned_bytes)
        temporary_path.replace(output_path)
        respond({"id": request_id, "ok": True, "bytes": len(cleaned_bytes)})
    except Exception as error:  # return a concise actionable error to Node
        respond({"id": request_id, "ok": False, "error": f"{type(error).__name__}: {error}"})

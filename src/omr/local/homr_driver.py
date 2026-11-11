# Runs homr (https://github.com/liebharc/homr, AGPL-3.0) in steps, so that the neural networks
# can be run by the caller between the steps instead of by Python's onnxruntime.
#
# In the browser this file runs inside Pyodide, where there is no onnxruntime and Python cannot
# wait for the (asynchronous) JavaScript one. So a page is read in phases:
#
#   job = Job(path)
#   job.segnet_batches(n) / job.segnet_batch(i) -> patches   -- caller runs the segmentation model
#   job.set_segnet_classes(i, classes)
#   job.detect()                                -> number of staff images
#   job.staff_input(i)                          -> tensor   -- caller runs encoder + decoder
#   job.set_staff_output(i, tokens, attention)
#   job.finish()                                -> MusicXML
#
# Written against homr 0.7.1; it replaces three of homr's functions and otherwise calls it unchanged.
import sys
import types
import xml.etree.ElementTree as ET

import numpy as np


def _stub(name, **attrs):
    if name in sys.modules:
        return
    try:
        __import__(name)
    except Exception:
        mod = types.ModuleType(name)
        for key, value in attrs.items():
            setattr(mod, key, value)
        sys.modules[name] = mod


class _Unavailable:
    def __init__(self, *args, **kwargs):
        raise RuntimeError("not available in this build")


# Modules homr imports at load time but which the phased pipeline never uses.
_stub(
    "onnxruntime",
    InferenceSession=_Unavailable,
    OrtValue=_Unavailable,
    get_available_providers=lambda: [],
    set_default_logger_severity=lambda level: None,
)
_stub("rapidocr", RapidOCR=_Unavailable)
_stub("pypdfium2", PdfDocument=_Unavailable)
_stub("requests")
_stub("lzma")

import homr.simple_logging as _logging  # noqa: E402

_log_lines = []


def _quiet_eprint(*args, **kwargs):
    _log_lines.append(" ".join(str(a) for a in args))
    del _log_lines[:-200]


_logging.eprint = _quiet_eprint
for _name, _mod in list(sys.modules.items()):
    if _name.startswith("homr") and getattr(_mod, "eprint", None) is not None:
        _mod.eprint = _quiet_eprint

import homr.main as _main  # noqa: E402
import homr.staff_parsing as _staff_parsing  # noqa: E402
from homr.music_xml_generator import XmlGeneratorArguments, generate_xml  # noqa: E402
from homr.segmentation import inference_segnet as _segnet  # noqa: E402
from homr.system_repair import repair_systems  # noqa: E402
from homr.transformer.configs import Config  # noqa: E402
from homr.transformer.staff2score import _transform  # noqa: E402
from homr.transformer.vocabulary import EncodedSymbol, is_upper_or_has_no_position  # noqa: E402

for _name, _mod in list(sys.modules.items()):
    if _name.startswith("homr") and getattr(_mod, "eprint", None) is not None:
        _mod.eprint = _quiet_eprint

WIN = 320
_SPECIAL = ("[BOS]", "[EOS]", "[PAD]")


def _array(value, dtype):
    """Accepts a numpy array or, in the browser, a JavaScript typed array."""
    if hasattr(value, "to_py"):
        value = value.to_py()
    return np.asarray(value).astype(dtype, copy=False)


class _Pause(Exception):
    """Raised inside homr to hand control back to the caller."""


def decoder_constants():
    """What the caller needs to run the decoder loop."""
    config = Config()
    return {
        "max_seq_len": int(config.max_seq_len),
        "eos_token": int(config.eos_token),
        "bos_token": int(config.bos_token),
        "nonote_token": int(config.nonote_token),
        "caches": int(config.decoder_depth * 4),
        "heads": int(config.decoder_heads),
        "head_dim": int(config.decoder_dim // config.decoder_heads),
    }


class Job:
    def __init__(self, image_path):
        self.image_path = image_path
        self.config = Config()
        self.inv = [
            {v: k for k, v in vocab.items()}
            for vocab in (
                self.config.rhythm_vocab,
                self.config.pitch_vocab,
                self.config.lift_vocab,
                self.config.position_vocab,
                self.config.articulation_vocab,
                self.config.slur_vocab,
            )
        ]
        self.processing = _main.ProcessingConfig(
            enable_debug=False,
            enable_cache=False,
            write_staff_positions=False,
            read_staff_positions=False,
            selected_staff=-1,
            transformer_use_gpu=False,
            segnet_use_gpu=False,
            coreml_encoder=False,
            title_detection=False,
        )
        self._image = None  # the grey page the segmentation model reads, uint8
        self._shape = None
        self._positions = []
        self._classes = {}
        self._prepared = {}
        self._staff_images = {}
        self._grand = {}
        self._outputs = {}
        self._detected = None

    # ---- phase 1: segmentation input -------------------------------------------------------
    def _collect_patches(self, image_org, use_gpu_inference, batch_size, step_size, win_size):
        if step_size < 0:
            step_size = win_size // 2
        self._step = step_size
        self._shape = (int(image_org.shape[0]), int(image_org.shape[1]))
        # homr turns the whole page into a float32 colour image here (60 MB); the patches are
        # built one by one from the grey page instead, which gives the same numbers
        self._image = np.ascontiguousarray(image_org)
        h, w = self._shape
        self._positions = []
        for y_loop in range(0, max(h, win_size), step_size):
            y = min(y_loop, h - win_size)
            for x_loop in range(0, max(w, win_size), step_size):
                x = min(x_loop, w - win_size)
                self._positions.append((y, x))
        raise _Pause()

    def segnet_patches(self):
        """Number of 320x320 patches the segmentation model has to see."""
        original = _segnet.inference
        _segnet.inference = self._collect_patches
        try:
            _main.detect_staffs_in_image(self.image_path, self.processing)
        except _Pause:
            pass
        finally:
            _segnet.inference = original
        return len(self._positions)

    def segnet_batch(self, start, count):
        """float32 [count, 3, 320, 320]"""
        patches = []
        for y, x in self._positions[start : start + count]:
            grey = _segnet.extract_patch(self._image[np.newaxis, :, :], y, x, WIN)
            patches.append(np.repeat(grey, 3, axis=0).astype(np.float32))
        return np.ascontiguousarray(np.stack(patches, axis=0))

    def set_segnet_classes(self, start, classes):
        """classes: uint8 [count, 320, 320], the arg-max class of every pixel."""
        classes = _array(classes, np.uint8).reshape(-1, WIN, WIN)
        for offset, patch in enumerate(classes):
            self._classes[start + offset] = patch.copy()

    # ---- phase 2: staff detection ----------------------------------------------------------
    def _merged_classes(self, image_org, use_gpu_inference, batch_size, step_size, win_size):
        # int64, as numpy's argmax gives homr: merge_patches keeps the type of the patches
        data = [self._classes[i].astype(np.int64) for i in range(len(self._positions))]
        self._classes = {}
        merged = _segnet.merge_patches(data, self._shape, win_size, self._step)
        stems_rests = (merged == 1).astype(np.uint8)
        notehead = (merged == 2).astype(np.uint8)
        clefs_keys = (merged == 3).astype(np.uint8)
        staff = (merged == 4).astype(np.uint8)
        symbols = (merged == 5).astype(np.uint8)
        return staff, symbols, stems_rests, notehead, clefs_keys

    def _prepare_once(self, debug, index, staff, staff_image, regions):
        if index not in self._prepared:
            self._prepared[index] = self._original_prepare(debug, index, staff, staff_image, regions)
        return self._prepared[index]

    def _parse_staffs(self, tromr):
        multi_staffs, image, debug, to_input_image = self._detected
        self._original_prepare = _staff_parsing.prepare_staff_image
        original_tromr = _staff_parsing.parse_staff_tromr
        _staff_parsing.prepare_staff_image = self._prepare_once
        _staff_parsing.parse_staff_tromr = tromr
        try:
            return _staff_parsing.parse_staffs(
                debug,
                multi_staffs,
                image,
                selected_staff=-1,
                config=self.config,
                page_to_input_image=to_input_image,
            )
        finally:
            _staff_parsing.prepare_staff_image = self._original_prepare
            _staff_parsing.parse_staff_tromr = original_tromr

    def detect(self):
        """Finds the staffs and cuts out one image per staff. Returns how many there are."""
        original = _segnet.inference
        _segnet.inference = self._merged_classes
        try:
            multi_staffs, image, debug, _title, _count, to_input_image = _main.detect_staffs_in_image(
                self.image_path, self.processing
            )
        finally:
            _segnet.inference = original
        self._image = None
        self._classes = {}
        multi_staffs = repair_systems(debug, multi_staffs)
        self._detected = (multi_staffs, image, debug, to_input_image)

        order = []

        def collect(staff, staff_image, config):
            index = len(order)
            order.append(index)
            self._staff_images[index] = staff_image
            self._grand[index] = bool(staff.is_grandstaff)
            return []

        try:
            self._parse_staffs(collect)
        except Exception:
            # with every staff "empty" homr may fail to assemble a result; only the images matter here
            pass
        return len(order)

    def staff_input(self, index):
        """float32 [1, 1, 256, 1280]"""
        return np.ascontiguousarray(_transform(image=self._staff_images[index]))

    def set_staff_output(self, index, tokens, attention):
        """
        tokens: int [steps, 6] in the order rhythm, pitch, lift, position, articulation, slur.
        attention: float [steps, k], the decoder's attention output of every step.
        """
        tokens = _array(tokens, np.int64).reshape(-1, 6)
        steps = tokens.shape[0]
        attention = _array(attention, np.float32).reshape(steps, -1) if steps else np.zeros((0, 2))
        symbols = []
        for step in range(steps):
            names = []
            for head in range(6):
                name = self.inv[head][int(tokens[step, head])]
                names.append(name)
            if any(name in _SPECIAL for name in names):
                # homr's own decoder would fail on these; skipping the symbol is the gentler choice
                continue
            rhythm, pitch, lift, position, articulation, slur = names
            symbols.append(
                EncodedSymbol(
                    rhythm=rhythm,
                    pitch=pitch,
                    lift=lift,
                    articulation=articulation,
                    slur=slur,
                    position=position,
                    coordinates=attention[step],
                )
            )
        self._outputs[index] = symbols

    # ---- phase 3: MusicXML -----------------------------------------------------------------
    def finish(self, title=""):
        counter = []

        def replay(staff, staff_image, config):
            index = len(counter)
            counter.append(index)
            result = self._outputs.get(index, [])
            if staff.is_grandstaff:
                return result
            return [r for r in result if is_upper_or_has_no_position(r.position)]

        result_staffs = self._parse_staffs(replay)
        xml = generate_xml(XmlGeneratorArguments(None, None, None), result_staffs, title)
        return ET.tostring(xml, encoding="unicode")


def log_tail(count=40):
    return "\n".join(_log_lines[-count:])

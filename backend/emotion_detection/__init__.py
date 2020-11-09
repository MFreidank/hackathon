import logging
from os import path
import typing

import cv2
import numpy as np
import torch
import torchvision.transforms as transforms
from PIL import Image

from emotion_detection.face_detection import NoFaceDetectedError, detect_faces_from_image
from emotion_detection.modeling import load_trained_model, MODEL_DIRECTORY


def detect_from_image_file(
    img_path: str, 
    model=None,
    model_path: str = path.join(MODEL_DIRECTORY, "FER_trained_model.pt"), 
    confidence_threshold: float = 0.2
) -> typing.Tuple[str, float]:
    """Detect and report emotions on a human face from a given image along with detection confidence.

    Parameters
    ----------
    img_path: str
        Path to an image file on disk. 
        See: https://docs.opencv.org/master/d4/da8/group__imgcodecs.html for details on supported file formats.
    model_path: str, optional
        Path to a serialized pytorch model checkpoint to use for detection.
        Defaults to a path to `FER_trained_model.pt`, a checkpoint trained on the FER dataset.
    confidence_threshold: float, optional
        Threshold to use on the detection confidence for detected emotions. 
        Detections under this threshold result in raising `emotion_detection.face_detection.NoFaceDetectedError`. 
        Default: `0.6`

    Returns
    -------
    detected_emotion: str
            * neutral
            * happiness
            * surprise
            * sadness
            * anger
            * disgust
            * fear

    detection_confidence: float
        Softmax score of the detection that roughly reflects prediction confidence.

    Raises
    ------
    emotion_detection.face_detection.NoFaceDetectedError
        Raised when confidence of the detection (prediction softmax) is below the user specified `confidence_threshold`. 
        Low-confidence detections are often an indication of a superfluous face detection from an unrelated (face-shaped) object.
    """
    if model is None:
        model = load_trained_model(model_path)
    model.cpu().eval()

    emotion_dict = {0: 'neutral', 1: 'happiness', 2: 'surprise', 3: 'sadness',
                    4: 'anger', 5: 'disgust', 6: 'fear'}

    val_transform = transforms.Compose([
        transforms.ToTensor()])

    img = cv2.imread(img_path)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    try:
        faces = detect_faces_from_image(img=img)
    except NoFaceDetectedError:
        raise
    
    if len(faces) > 1:
        print("Warning, detected multiple faces, reporting dominant emotion of only the first one of them.")
        (x, y, w, h), *_ = faces
    else:
        (x, y, w, h), = faces

    emotions = {}
    for (x, y, w, h) in faces:
        resize_frame = cv2.resize(gray[y:y + h, x:x + w], (48, 48))
        X = resize_frame/256
        X = Image.fromarray((resize_frame))
        X = val_transform(X).unsqueeze(0)
        with torch.no_grad():
            model.eval()
            log_ps = model(X)
            ps = torch.exp(log_ps)
            top_p, top_class = ps.topk(1, dim=1)
            predicted_emotion = emotion_dict[int(top_class.numpy())]
            prediction_confidence = top_p.item()  
            emotions[predicted_emotion] = prediction_confidence

    try:
        _ = emotions.pop("neutral")
    except KeyError:
        pass

    print(emotions)

    highest_predicted_emotion, confidence = max(emotions.items(), key=lambda emotion_prediction: emotion_prediction[1], default=("neutral", 1.0))

    if confidence < confidence_threshold:
        return ("neutral", 1.0)

    return (highest_predicted_emotion, confidence)

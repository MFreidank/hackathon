import cv2
from os import path
import face_recognition
import typing

from emotion_detection.modeling import MODEL_DIRECTORY

class NoFaceDetectedError(ValueError):
    """Raised if an image passed to emotion detection does not contain a face."""


def detect_faces_from_image(
    img,
):
    locations = face_recognition.face_locations(img)
    face_locations = []

    # NOTE: Reformat face locations to expected format for emotion detector
    for (bottom, right, top, left) in locations:
        face_locations.append(
            (left, bottom, (right - left), (top - bottom))
        )

    if len(face_locations) == 0:
        raise NoFaceDetectedError

    return face_locations

# NOTE: Legacy implementation using cv2; dlib based one used above was found to perform better
# def detect_faces_from_image(
#     img,
#     model_path: str = path.join(MODEL_DIRECTORY, "haarcascade_frontalface_default.xml")
# ) -> typing.List[typing.List[int]]:
#     """Use a cascade classifier to detect presence and location of human faces in the given image.
# 
#     Parameters
#     ----------
#     img: TODO
#         Image object to detect faces in.
#     model_path: str, optional
#         Path to a cascade description used to model human faces for detection.
#         Defaults to a path to `haarcascade_frontalace_default.xml`.
# 
#     Returns
#     -------
#     face_coordinates: typing.List[typing.List[int]]
#         List of edge points defining occurences of human faces that were detected.
# 
#     Raises
#     ------
#     emotion_detection.face_detection.NoFaceDetectedError
#         Raised when the given image contains no objects matching our model for human faces.
#     """
#     face_cascade = cv2.CascadeClassifier(model_path)
#     faces = face_cascade.detectMultiScale(img)
#     print("Faces:", faces)
# 
#     if len(faces) == 0:
#         raise NoFaceDetectedError
#     return faces

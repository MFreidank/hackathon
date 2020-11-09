# DayOne Hackathon Project - Self-Radar
Towards Improved Prediction and Management - An Interactive Patient Diary, Emotional Radar and Helper
To do this we envision a system that can understand, contextualise, then explore and learn based on a number of ‘metadata’ inputs

We’d like to simplify the ‘data entry’ part of the tracker diary, e.g. so that it just becomes part of a ‘natural conversation’. - Lowering the barrier to continued use. We believe that it will only become sticky if it gives something back to the users - the ability for self-management.

We would like to personalize the system, so that we start to understand the holistic picture of someone’s wellness. (e.g. using Facial clues, sentiment analysis, voice tone etc.) We could track these softer elements, along with other more traditional digital biomarkers. The emotional state gives us some clues of how someone is feeling, which could help guide the question directions. Lastly, the emotional state itself could be used as a broad biomarker.

# Material
- Pitch video -> https://www.youtube.com/watch?v=f-Cmzly5gpw
- Link to the project page -> https://2020.healthhack.solutions/project/74

![Video](https://raw.githubusercontent.com/onnobos/hackathon/main/thumbnail.jpg)

# Flow Diagram
![Flow diagram](https://raw.githubusercontent.com/onnobos/hackathon/main/FlowDiagram.png)

# Solution Diagram
![Solution diagram](https://raw.githubusercontent.com/onnobos/hackathon/main/Solution_Diagram.png)

# Our Avatar
![Avatar](https://raw.githubusercontent.com/onnobos/hackathon/main/load_screen.png)

# AIM Role for Cognito_TestPoolUnauth_Role required setup
  AmazonPollyFullAccess
  DetectSentimentPolicy
    Comprehend -> Limited: Read -> -> All resources
  WebSocketsTranscribe
    Transcribe -> Limited: Write -> All resources

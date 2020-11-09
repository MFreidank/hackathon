import argparse
import emotion_detection

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input_filename")
    args = parser.parse_args()

    print(emotion_detection.detect_from_image_file(args.input_filename))

if __name__ == "__main__":
    main()

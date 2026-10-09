import os
import sys
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

from whatsapp_notifier import send_whatsapp_message_sync, format_emergency_message

def test_send_alert():
    print("=== GuardianRide WhatsApp Dispatch Test ===")
    token = os.getenv("GREEN_API_TOKEN_INSTANCE")
    if not token:
        print("[Error] GREEN_API_TOKEN_INSTANCE is not set in backend/.env!")
        print("Please copy your apiTokenInstance from the Green API console into backend/.env")
        sys.exit(1)

    print(f"API URL: {os.getenv('GREEN_API_URL', 'https://7107.api.greenapi.com')}")
    print(f"Instance ID: {os.getenv('GREEN_API_ID_INSTANCE', '710722761057')}")
    print(f"Target Phone: {os.getenv('EMERGENCY_DISPATCH_PHONE', '962795668098')}")
    print("Dispatching test 911 emergency alert...")


    # Amman Business Park test coordinates
    test_lat, test_lon = 31.9715, 35.8354
    
    msg = format_emergency_message(
        incident_type="EMERGENCY SOS BUTTON ACTIVATED BY PASSENGER",
        confidence=1.0,
        latitude=test_lat,
        longitude=test_lon,
        status="MANUAL_SOS_TRIGGERED",
        details="In-cabin tablet SOS button was pressed manually by passenger Leen."
    )

    result = send_whatsapp_message_sync(msg)
    print("Result:", result)


if __name__ == "__main__":
    test_send_alert()

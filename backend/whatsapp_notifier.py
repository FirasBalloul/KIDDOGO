import os
import asyncio
import datetime
import requests
from typing import Optional, Tuple
from dotenv import load_dotenv

# Ensure initial dotenv is loaded
load_dotenv()

def get_config():
    """Dynamically reloads .env so phone number or token updates take effect instantly."""
    load_dotenv(override=True)
    return {
        "url": os.getenv("GREEN_API_URL", "https://7107.api.greenapi.com").rstrip("/"),
        "id_instance": os.getenv("GREEN_API_ID_INSTANCE", "710722761057"),
        "token_instance": os.getenv("GREEN_API_TOKEN_INSTANCE", ""),
        "phone": os.getenv("EMERGENCY_DISPATCH_PHONE", "962795668098"),
        "enabled": os.getenv("WHATSAPP_ALERTS_ENABLED", "true").lower() in ("true", "1", "yes")
    }

def _normalize_phone_to_chat_id(phone: str) -> str:
    """Formats a raw phone number into Green API chatId format (e.g., 962795668098@c.us)."""
    clean_number = "".join(filter(str.isdigit, phone))
    return f"{clean_number}@c.us"

def _get_bilingual_incident_titles(incident_type: str) -> Tuple[str, str]:
    """Returns official (Arabic, English) incident titles."""
    inc_upper = incident_type.upper()
    
    if "MANUAL" in inc_upper or "SOS" in inc_upper:
        return (
            "تم تفعيل زر الاستغاثة اليدوي (SOS) من داخل المقصورة",
            "EMERGENCY SOS BUTTON ACTIVATED BY PASSENGER"
        )
    elif "UNAUTHORIZED VOICE" in inc_upper or "IMPOSTOR" in inc_upper or "OVERRIDE" in inc_upper:
        return (
            "خرق أمني: محاولة شخص غريب/السائق إلغاء فحص الأمان الصوتي",
            "SECURITY BREACH: Unauthorized Voice Override Attempted"
        )
    elif "CORRIDOR" in inc_upper or "DEVIATION" in inc_upper or "OFF-ROUTE" in inc_upper:
        return (
            "انحراف عن المسار: المركبة خرجت عن مسار الرحلة المعتمد",
            "ROUTE ANOMALY: Vehicle Significantly Off Planned Route"
        )
    elif "STATIONARY" in inc_upper or "STOP" in inc_upper:
        return (
            "توقف غير مجدول: المركبة متوقفة في منطقة غير مصرح بها",
            "UNEXPECTED STOP: Vehicle Stationary in Unauthorized Zone"
        )
    elif "SPATIAL" in inc_upper or "BOUNDARY" in inc_upper or "BREACH" in inc_upper:
        return (
            "خرق المقصورة: تجاوز الحاجز الفاصل بين السائق والركاب",
            "CABIN INTRUSION: Physical Boundary Breach Detected"
        )
    elif "SCREAM" in inc_upper or "CRY" in inc_upper or "SHOUT" in inc_upper or "DISTRESS" in inc_upper:
        return (
            "حالة استغاثة صوتية: رصد بكاء أو صراخ استغاثة داخل المقصورة",
            "CABIN DISTRESS: Severe Vocal Emergency Detected"
        )
    elif "TEST" in inc_upper:
        return (
            "فحص تجريبي: التحقق من جاهزية نظام طوارئ 911",
            "SYSTEM TEST: Emergency 911 Dispatch Verification"
        )
    
    return (incident_type.strip(), incident_type.strip())

def format_emergency_message(
    incident_type: str,
    confidence: float = 0.95,
    latitude: Optional[float] = None,
    longitude: Optional[float] = None,
    status: str = "CRITICAL_ALERT",
    details: str = "",
    vehicle_id: str = "Fleet #4092 (Amman)",
    passenger_id: str = "Child Passenger (child_01)"
) -> str:
    """
    Builds an authentic Bilingual (Arabic + English) 911 / Operations Emergency Dispatch alert.
    Strictly clean, official layout without any emojis.
    """
    ar_title, en_title = _get_bilingual_incident_titles(incident_type)
    now_str = datetime.datetime.now().strftime("%I:%M:%S %p")
    
    maps_link = f"https://maps.google.com/?q={latitude},{longitude}" if (latitude and longitude) else "Tracking Unavailable"
    
    is_urgent_sos = "SOS" in incident_type.upper() or "SOS" in status.upper() or "IMPOSTOR" in status.upper()
    priority_ar = "قصوى (كود أحمر)" if is_urgent_sos else "عالية (كود أصفر)"
    priority_en = "CRITICAL (CODE RED)" if is_urgent_sos else "HIGH PRIORITY (CODE YELLOW)"

    # Clean up details to ensure it reads like an official operational log
    clean_details = details
    for tech_term in ["sliding window", "fusion score", "temporal", "fused_score", "cosine"]:
        if tech_term in clean_details.lower():
            clean_details = "Automated in-cabin safety sensor triggered emergency threshold."

    msg = (
        "*[بلاغ طوارئ رسمي - غرفة عمليات بترا رايد / 911]*\n"
        "*[OFFICIAL 911 / AMMAN CENTRAL EMERGENCY DISPATCH]*\n"
        "=========================================\n"
        f"*درجة الأهمية / PRIORITY:* {priority_ar} | {priority_en}\n"
        f"*الوقت / TIME:* {now_str} (Amman GMT+3)\n"
        f"*المركبة / VEHICLE:* Petra SafeTrack {vehicle_id}\n"
        f"*الراكب / PASSENGER:* {passenger_id}\n\n"
        f"*نوع الحادث / INCIDENT TYPE:*\n"
        f"• {ar_title}\n"
        f"• {en_title}\n\n"
        f"*رابط التتبع المباشر / LIVE GPS NAVIGATION:*\n"
        f"{maps_link}\n"
    )

    if clean_details:
        msg += f"\n*ملخص العمليات / OPERATIONS SUMMARY:*\n{clean_details}\n"

    msg += (
        "\n=========================================\n"
        "*الإجراء المطلوب / ACTION REQUIRED:*\n"
        "تم تعميم البلاغ لغرفة العمليات المركزية لمتابعة موقع المركبة وتوجيه أقرب دورية.\n"
        "Operations control room has flagged this unit for immediate responder and patrol dispatch.\n"
        "*Amman Central Operations:* +962 6 500 0000 | *Emergency / الطوارئ:* 911"
    )
    return msg

def send_whatsapp_message_sync(message_body: str, phone: Optional[str] = None) -> dict:
    """Synchronous call to Green API sendMessage with dynamic config resolution."""
    config = get_config()

    if not config["enabled"]:
        return {"status": "DISABLED", "message": "WhatsApp alerts are disabled in config."}
    
    if not config["token_instance"]:
        print("[WhatsApp Notifier] Warning: GREEN_API_TOKEN_INSTANCE is missing in .env")
        return {"status": "ERROR", "message": "Missing Green API token."}

    target_phone = phone or config["phone"]
    chat_id = _normalize_phone_to_chat_id(target_phone)
    
    url = f"{config['url']}/waInstance{config['id_instance']}/sendMessage/{config['token_instance']}"
    payload = {
        "chatId": chat_id,
        "message": message_body
    }
    headers = {
        "Content-Type": "application/json"
    }

    try:
        response = requests.post(url, json=payload, headers=headers, timeout=10)
        resp_data = response.json() if response.content else {}
        if response.status_code == 200:
            print(f"[WhatsApp Notifier] Emergency Alert dispatched to {chat_id}: {resp_data}")
            return {"status": "SENT", "response": resp_data}
        else:
            print(f"[WhatsApp Notifier] API Error {response.status_code}: {response.text}")
            return {"status": "FAILED", "code": response.status_code, "error": response.text}
    except Exception as e:
        print(f"[WhatsApp Notifier] Exception sending alert: {e}")
        return {"status": "ERROR", "error": str(e)}

async def send_whatsapp_alert_async(
    incident_type: str,
    confidence: float = 0.95,
    latitude: Optional[float] = None,
    longitude: Optional[float] = None,
    status: str = "CRITICAL_ALERT",
    details: str = "",
    phone: Optional[str] = None
):
    """
    Non-blocking async dispatch wrapper.
    Executes the Green API HTTP request on a worker thread.
    """
    config = get_config()
    if not config["enabled"]:
        return
    
    body = format_emergency_message(
        incident_type=incident_type,
        confidence=confidence,
        latitude=latitude,
        longitude=longitude,
        status=status,
        details=details
    )
    return await asyncio.to_thread(send_whatsapp_message_sync, body, phone)

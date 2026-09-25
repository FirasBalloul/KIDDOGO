from sqlalchemy import Column, Integer, String, Float, DateTime
from database import Base
from datetime import datetime

class Alert(Base):
    __tablename__ = "alerts"

    id = Column(Integer, primary_key=True, index=True)
    sound_type = Column(String, index=True)
    confidence = Column(Float)
    latitude = Column(Float, nullable=True)
    longitude = Column(Float, nullable=True)
    timestamp = Column(DateTime, default=datetime.utcnow)
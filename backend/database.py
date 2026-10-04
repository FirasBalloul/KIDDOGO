import os
from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

# Configured database URL with environment variable support
DATABASE_URL = os.getenv(
    "DATABASE_URL", 
    "postgresql+psycopg://petra:password@localhost:5432/guardian"
)

try:
    if DATABASE_URL.startswith("sqlite"):
        engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
    else:
        # Test postgres engine connection
        engine = create_engine(DATABASE_URL, pool_pre_ping=True)
        # Attempt connection check
        with engine.connect() as conn:
            pass
except Exception as e:
    # Graceful fallback to SQLite for local development/testing without Docker
    print(f"[DB Notice] PostgreSQL connection failed ({e}). Falling back to local SQLite database.")
    DATABASE_URL = "sqlite:///./guardian.db"
    engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
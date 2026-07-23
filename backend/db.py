import datetime
import json
from sqlalchemy import create_engine, Column, Integer, String, Text, DateTime, JSON, ForeignKey, event, inspect, text
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
import os

# 数据库文件路径
DB_PATH = os.path.join(os.path.dirname(__file__), "history.db")
SQLALCHEMY_DATABASE_URL = f"sqlite:///{DB_PATH}"

engine = create_engine(
    SQLALCHEMY_DATABASE_URL, 
    connect_args={"check_same_thread": False, "timeout": 30} # 增加到30秒超时
)

def enable_sqlite_foreign_keys(db_engine):
    if db_engine.dialect.name != "sqlite":
        return

    @event.listens_for(db_engine, "connect")
    def set_sqlite_pragma(dbapi_connection, connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()


enable_sqlite_foreign_keys(engine)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

class AnalysisHistory(Base):
    __tablename__ = "analysis_history"
    id = Column(Integer, primary_key=True, index=True)
    timestamp = Column(DateTime, default=datetime.datetime.now)
    query_url = Column(Text)
    template_type = Column(String(50)) # 'single' or 'matrix'
    data = Column(JSON) # 完整的响应 JSON

class ListingHistory(Base):
    __tablename__ = "listing_history"
    id = Column(Integer, primary_key=True, index=True)
    timestamp = Column(DateTime, default=datetime.datetime.now)
    product_name = Column(String(255))
    platform = Column(String(50))
    result = Column(JSON) # 包含标题、卖点、描述等

class TranslationHistory(Base):
    __tablename__ = "translation_history"
    id = Column(Integer, primary_key=True, index=True)
    timestamp = Column(DateTime, default=datetime.datetime.now)
    source_text = Column(Text)
    target_lang = Column(String(50))
    image_url = Column(Text, nullable=True) # 如果涉及图片
    result = Column(JSON)

class TextTranslationHistory(Base):
    __tablename__ = "text_translation_history"
    id = Column(Integer, primary_key=True, index=True)
    timestamp = Column(DateTime, default=datetime.datetime.now)
    source_text = Column(Text)
    target_lang = Column(String(50))
    context = Column(String(255), nullable=True)
    result = Column(Text) # 直接存储翻译结果

class AdsHistory(Base):
    __tablename__ = "ads_history"
    id = Column(Integer, primary_key=True, index=True)
    timestamp = Column(DateTime, default=datetime.datetime.now)
    product_name = Column(String(255))
    platforms = Column(String(255))
    region = Column(String(100))
    target_lang = Column(String(50))
    marketing_theme = Column(String(255), nullable=True)
    image_url = Column(Text, nullable=True)
    result = Column(JSON)

class RenderHistory(Base):
    __tablename__ = "render_history"
    id = Column(Integer, primary_key=True, index=True)
    timestamp = Column(DateTime, default=datetime.datetime.now)
    task_name = Column(String(255))
    style = Column(Text)
    image_base64 = Column(Text) # 存储生成的图片
    metadata_info = Column(JSON) # 包含文案等信息

class SquareRedrawHistory(Base):
    __tablename__ = "square_redraw_history"
    id = Column(Integer, primary_key=True, index=True)
    timestamp = Column(DateTime, default=datetime.datetime.now)
    batch_id = Column(Integer, index=True)
    target_aspect_ratio = Column(String(20), default="1:1")
    result = Column(JSON)

class SquareRedrawBatch(Base):
    __tablename__ = "square_redraw_batches"
    id = Column(Integer, primary_key=True, index=True)
    created_at = Column(DateTime, default=datetime.datetime.now)
    updated_at = Column(DateTime, default=datetime.datetime.now, onupdate=datetime.datetime.now)
    status = Column(String(30), default="queued", index=True)
    target_aspect_ratio = Column(String(20), default="1:1")
    output_dir = Column(Text)
    zip_path = Column(Text, nullable=True)

class SquareRedrawItem(Base):
    __tablename__ = "square_redraw_items"
    id = Column(Integer, primary_key=True, index=True)
    batch_id = Column(Integer, ForeignKey("square_redraw_batches.id"), nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.datetime.now)
    updated_at = Column(DateTime, default=datetime.datetime.now, onupdate=datetime.datetime.now)
    source_filename = Column(String(255))
    source_mime_type = Column(String(100))
    source_width = Column(Integer, nullable=True)
    source_height = Column(Integer, nullable=True)
    status = Column(String(30), default="queued", index=True)
    retry_count = Column(Integer, default=0)
    source_url = Column(Text, nullable=True)
    output_url = Column(Text, nullable=True)
    error_message = Column(Text, nullable=True)


class AIProviderConfig(Base):
    __tablename__ = "ai_provider_configs"
    id = Column(Integer, primary_key=True)
    name = Column(String(120), nullable=False, unique=True)
    protocol = Column(String(32), nullable=False)
    base_url = Column(Text, nullable=True)
    api_key = Column(Text, nullable=True)
    vertex_project_id = Column(Text, nullable=True)
    vertex_location = Column(String(80), nullable=True)
    vertex_key_path = Column(Text, nullable=True)
    text_model = Column(Text, nullable=True)
    image_model = Column(Text, nullable=True)
    supports_text = Column(Integer, nullable=False, default=1)
    supports_image = Column(Integer, nullable=False, default=0)
    timeout_seconds = Column(Integer, nullable=False, default=60)
    max_retries = Column(Integer, nullable=False, default=2)
    enabled = Column(Integer, nullable=False, default=1)
    last_test_status = Column(String(30), nullable=True)
    last_test_message = Column(Text, nullable=True)
    last_tested_at = Column(DateTime, nullable=True)
    config_version = Column(Integer, nullable=False, default=1)
    created_at = Column(DateTime, default=datetime.datetime.now)
    updated_at = Column(DateTime, default=datetime.datetime.now, onupdate=datetime.datetime.now)


class AICapabilityBinding(Base):
    __tablename__ = "ai_capability_bindings"
    capability = Column(String(16), primary_key=True)
    provider_config_id = Column(
        Integer, ForeignKey("ai_provider_configs.id"), nullable=False
    )
    updated_at = Column(DateTime, default=datetime.datetime.now, onupdate=datetime.datetime.now)

# 创建所有表
def init_db():
    Base.metadata.create_all(bind=engine)
    migrate_square_redraw_tables()
    migrate_ai_settings_tables()


def migrate_square_redraw_tables():
    if engine.dialect.name != "sqlite":
        return

    inspector = inspect(engine)
    if "square_redraw_batches" not in inspector.get_table_names():
        return

    existing_columns = {column["name"] for column in inspector.get_columns("square_redraw_batches")}
    with engine.begin() as connection:
        if "target_aspect_ratio" not in existing_columns:
            connection.execute(text("ALTER TABLE square_redraw_batches ADD COLUMN target_aspect_ratio VARCHAR(20) DEFAULT '1:1'"))


def migrate_ai_settings_tables():
    """Create the settings tables without modifying existing table columns."""
    Base.metadata.create_all(bind=engine)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

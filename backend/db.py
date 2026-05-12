import datetime
import json
from sqlalchemy import create_engine, Column, Integer, String, Text, DateTime, JSON
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

class RenderHistory(Base):
    __tablename__ = "render_history"
    id = Column(Integer, primary_key=True, index=True)
    timestamp = Column(DateTime, default=datetime.datetime.now)
    task_name = Column(String(255))
    style = Column(Text)
    image_base64 = Column(Text) # 存储生成的图片
    metadata_info = Column(JSON) # 包含文案等信息

# 创建所有表
def init_db():
    Base.metadata.create_all(bind=engine)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

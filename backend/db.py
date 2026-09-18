import datetime
import json
import uuid

from sqlalchemy import create_engine, Column, Integer, String, Text, DateTime, JSON, ForeignKey, Index, event, inspect, text
from sqlalchemy.orm import declarative_base, sessionmaker
import os

# 数据库文件路径
DB_PATH = os.getenv("SQLITE_DB_PATH") or os.path.join(os.path.dirname(__file__), "history.db")
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
        try:
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA busy_timeout=5000")
            cursor.execute("PRAGMA synchronous=NORMAL")
        except Exception:
            pass
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


class WatermarkRemovalHistory(Base):
    __tablename__ = "watermark_removal_history"
    id = Column(Integer, primary_key=True, index=True)
    timestamp = Column(DateTime, default=datetime.datetime.now)
    filename = Column(String(255))
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


class AppSetting(Base):
    __tablename__ = "app_settings"
    key = Column(String(100), primary_key=True)
    value = Column(JSON, nullable=True)
    updated_at = Column(DateTime, default=datetime.datetime.now, onupdate=datetime.datetime.now)



class AIProviderConfig(Base):
    __tablename__ = "ai_provider_configs"
    __table_args__ = (
        Index(
            "ux_ai_provider_configs_incarnation_id",
            "incarnation_id",
            unique=True,
        ),
    )

    id = Column(Integer, primary_key=True)
    incarnation_id = Column(
        String(36),
        nullable=False,
        default=lambda: str(uuid.uuid4()),
    )
    name = Column(String(120), nullable=False, unique=True)
    protocol = Column(String(32), nullable=False)
    base_url = Column(Text, nullable=True)
    api_key = Column(Text, nullable=True)
    vertex_project_id = Column(Text, nullable=True)
    vertex_location = Column(String(80), nullable=True)
    vertex_key_path = Column(Text, nullable=True)
    text_model = Column(Text, nullable=True)
    image_model = Column(Text, nullable=True)
    image_generation_mode = Column(
        String(32), nullable=False, default="image_to_image"
    )
    supports_text = Column(Integer, nullable=False, default=1)
    supports_image = Column(Integer, nullable=False, default=0)
    timeout_seconds = Column(Integer, nullable=False, default=60)
    max_retries = Column(Integer, nullable=False, default=2)
    enabled = Column(Integer, nullable=False, default=1)
    last_test_status = Column(String(30), nullable=True)
    last_test_message = Column(Text, nullable=True)
    last_tested_at = Column(DateTime, nullable=True)
    last_test_capability = Column(String(16), nullable=True)
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


class StorageConfig(Base):
    __tablename__ = "storage_configs"

    id = Column(Integer, primary_key=True)
    storage_type = Column(String(32), nullable=False)  # 'wordpress', 'shopify', or 'r2'
    name = Column(String(120), nullable=True)  # User-defined site/store remark
    is_default = Column(Integer, nullable=False, default=0)  # 1 if active default for this storage_type
    enabled = Column(Integer, nullable=False, default=1)

    # WordPress fields
    wp_url = Column(Text, nullable=True)
    wp_username = Column(String(120), nullable=True)
    wp_app_password = Column(Text, nullable=True)

    # Shopify fields
    shopify_shop_domain = Column(String(120), nullable=True)
    shopify_access_token = Column(Text, nullable=True)

    # Cloudflare R2 fields
    r2_account_id = Column(String(120), nullable=True)
    r2_access_key_id = Column(String(120), nullable=True)
    r2_secret_access_key = Column(Text, nullable=True)
    r2_bucket_name = Column(String(120), nullable=True)
    r2_public_url = Column(Text, nullable=True)
    r2_path_prefix = Column(String(120), nullable=True, default="pdp/")

    # Diagnostics
    last_test_status = Column(String(30), nullable=True)
    last_test_message = Column(Text, nullable=True)
    last_tested_at = Column(DateTime, nullable=True)

    created_at = Column(DateTime, default=datetime.datetime.now)
    updated_at = Column(DateTime, default=datetime.datetime.now, onupdate=datetime.datetime.now)


class FirecrawlConfig(Base):
    __tablename__ = "firecrawl_configs"

    id = Column(Integer, primary_key=True)
    api_key = Column(Text, nullable=True)
    api_url = Column(Text, nullable=False, default="https://api.firecrawl.dev/v1/scrape")
    last_test_status = Column(String(30), nullable=True)
    last_test_message = Column(Text, nullable=True)
    last_tested_at = Column(DateTime, nullable=True)

    created_at = Column(DateTime, default=datetime.datetime.now)
    updated_at = Column(DateTime, default=datetime.datetime.now, onupdate=datetime.datetime.now)


# 创建所有表
def init_db():
    Base.metadata.create_all(bind=engine)
    migrate_square_redraw_tables()
    migrate_ai_settings_tables()
    migrate_storage_tables()


def migrate_storage_tables():
    Base.metadata.create_all(bind=engine)
    if engine.dialect.name != "sqlite":
        return

    inspector = inspect(engine)
    if "storage_configs" not in inspector.get_table_names():
        return

    columns = {col["name"] for col in inspector.get_columns("storage_configs")}
    unique_constraints = inspector.get_unique_constraints("storage_configs")
    indexes = inspector.get_indexes("storage_configs")

    has_type_unique = False
    for uc in unique_constraints:
        if uc.get("column_names") == ["storage_type"]:
            has_type_unique = True
            break
    for idx in indexes:
        if idx.get("unique") and idx.get("column_names") == ["storage_type"]:
            has_type_unique = True
            break

    needs_migration = has_type_unique or "name" not in columns or "shopify_shop_domain" not in columns

    if needs_migration:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE storage_configs RENAME TO storage_configs_old"))
            Base.metadata.tables["storage_configs"].create(bind=conn)

            old_cols = [c["name"] for c in inspector.get_columns("storage_configs_old")]
            common_cols = [
                c for c in old_cols
                if c in (
                    "id", "storage_type", "enabled", "wp_url", "wp_username", "wp_app_password",
                    "r2_account_id", "r2_access_key_id", "r2_secret_access_key", "r2_bucket_name",
                    "r2_public_url", "r2_path_prefix", "last_test_status", "last_test_message",
                    "last_tested_at", "created_at", "updated_at"
                )
            ]
            cols_str = ", ".join(common_cols)
            conn.execute(text(f"""
                INSERT INTO storage_configs ({cols_str}, name, is_default)
                SELECT {cols_str},
                    CASE
                        WHEN storage_type = 'wordpress' THEN coalesce(wp_username || ' (' || wp_url || ')', '默认 WordPress 站点')
                        WHEN storage_type = 'r2' THEN '默认 Cloudflare R2'
                        ELSE '默认配置'
                    END as name,
                    1 as is_default
                FROM storage_configs_old
            """))
            conn.execute(text("DROP TABLE storage_configs_old"))


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
    """Create settings tables and add backward-compatible optional columns."""
    Base.metadata.create_all(bind=engine)
    if engine.dialect.name != "sqlite":
        return

    inspector = inspect(engine)
    if "ai_provider_configs" not in inspector.get_table_names():
        return

    existing_columns = {
        column["name"]
        for column in inspector.get_columns("ai_provider_configs")
    }
    if "last_test_capability" not in existing_columns:
        with engine.begin() as connection:
            connection.execute(
                text(
                    "ALTER TABLE ai_provider_configs "
                    "ADD COLUMN last_test_capability VARCHAR(16)"
                )
            )
    if "incarnation_id" not in existing_columns:
        with engine.begin() as connection:
            connection.execute(
                text(
                    "ALTER TABLE ai_provider_configs "
                    "ADD COLUMN incarnation_id VARCHAR(36)"
                )
            )
    if "image_generation_mode" not in existing_columns:
        with engine.begin() as connection:
            connection.execute(
                text(
                    "ALTER TABLE ai_provider_configs "
                    "ADD COLUMN image_generation_mode VARCHAR(32) "
                    "NOT NULL DEFAULT 'image_to_image'"
                )
            )

    with engine.begin() as connection:
        rows = connection.execute(
            text(
                "SELECT id, incarnation_id "
                "FROM ai_provider_configs ORDER BY id"
            )
        ).mappings()
        seen = set()
        for row in rows:
            value = row["incarnation_id"]
            valid = False
            if isinstance(value, str) and value.strip():
                try:
                    uuid.UUID(value)
                    valid = value not in seen
                except ValueError:
                    valid = False
            if not valid:
                value = str(uuid.uuid4())
                while value in seen:
                    value = str(uuid.uuid4())
                connection.execute(
                    text(
                        "UPDATE ai_provider_configs "
                        "SET incarnation_id = :incarnation_id "
                        "WHERE id = :provider_id"
                    ),
                    {
                        "incarnation_id": value,
                        "provider_id": row["id"],
                    },
                )
            seen.add(value)
        connection.execute(
            text(
                "CREATE UNIQUE INDEX IF NOT EXISTS "
                "ux_ai_provider_configs_incarnation_id "
                "ON ai_provider_configs (incarnation_id)"
            )
        )

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from db import get_db
from models.storage import (
    ImageUploadRequest,
    ImageUploadResponse,
    StorageConfigRead,
    StorageConfigWrite,
    StorageTestRequest,
    StorageTestResponse,
)
from services.storage_service import (
    delete_storage_config,
    get_all_storage_configs,
    save_storage_config,
    set_default_storage_config,
    test_storage_connection,
    upload_image_dispatcher,
)

router = APIRouter()


@router.get("/configs", response_model=list[StorageConfigRead], summary="获取所有媒体库与对象存储配置")
def get_configs_endpoint(db: Session = Depends(get_db)):
    return get_all_storage_configs(db)


@router.post("/config", response_model=StorageConfigRead, summary="保存或更新存储配置")
def save_config_endpoint(payload: StorageConfigWrite, db: Session = Depends(get_db)):
    try:
        return save_storage_config(payload, db)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"保存存储配置失败: {str(e)}")


@router.delete("/config/{config_id}", summary="删除指定存储配置")
def delete_config_endpoint(config_id: int, db: Session = Depends(get_db)):
    success = delete_storage_config(config_id, db)
    if not success:
        raise HTTPException(status_code=404, detail="未找到指定的存储配置")
    return {"success": True, "message": "存储配置已删除"}


@router.post("/config/{config_id}/default", response_model=StorageConfigRead, summary="设为默认存储配置")
def set_default_config_endpoint(config_id: int, db: Session = Depends(get_db)):
    res = set_default_storage_config(config_id, db)
    if not res:
        raise HTTPException(status_code=404, detail="未找到指定的存储配置")
    return res


@router.post("/test", response_model=StorageTestResponse, summary="测试存储连接性")
async def test_connection_endpoint(payload: StorageTestRequest, db: Session = Depends(get_db)):
    try:
        config_override = payload.resolve_override()
        return await test_storage_connection(
            storage_type=payload.storage_type,
            db=db,
            config_override=config_override,
        )
    except Exception as e:
        return StorageTestResponse(
            success=False,
            message=f"测试存储连通性出现未捕获异常: {str(e)}",
        )


@router.post("/upload-image", response_model=ImageUploadResponse, summary="代理上传单张图片至指定存储")
async def upload_image_endpoint(payload: ImageUploadRequest, db: Session = Depends(get_db)):
    try:
        res = await upload_image_dispatcher(payload, db)
        return res
    except Exception as e:
        return ImageUploadResponse(
            success=False,
            storage_type=payload.storage_type,
            filename=payload.filename,
            error=f"上传服务发生异常: {str(e)}",
        )

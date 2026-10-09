"""Run explicitly after backup; startup never invokes this migration."""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from services.research_repository import migrate


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--database', required=True, type=Path)
    args = parser.parse_args()
    if not args.database.is_file():
        parser.error('database must already exist and be backed up')
    migrate(args.database)
    print('research schema revision 1 ready; legacy tables unchanged')

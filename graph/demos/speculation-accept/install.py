"""Install the frozen extractor-header Bloom projection."""
import json
from pathlib import Path
from install_steps import install

if __name__ == '__main__':
    install(json.loads(Path(__file__).with_name('steps-projection.json').read_text(encoding='utf-8')))

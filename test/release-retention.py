"""发布清理范围回归；不调用 Docker，不读取部署秘密。"""
import runpy
import tempfile
import unittest
from pathlib import Path

module = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'ops/release.py'))


class RetentionTests(unittest.TestCase):
    def test_only_owned_old_versions(self):
        '''只移除本项目三版之外的标签，保留外部项目。'''
        images = [{'repo': 'flowus-helix', 'tag': f'release-{i}', 'id': str(i), 'created': str(i)} for i in range(5)]
        images += [{'repo': 'other', 'tag': 'release-0', 'id': 'x', 'created': '0'}]
        self.assertEqual(module['image_retention'](images, '4'), ['flowus-helix:release-0', 'flowus-helix:release-1'])

    def test_recursive_lazy_chunk_kept(self):
        '''保留主入口间接加载资源，删除旧哈希文件。'''
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'assets').mkdir()
            (root / 'index.html').write_text('assets/main-new.js')
            for name, content in [('main-new.js', 'lazy-new.js'), ('lazy-new.js', 'ok'), ('main-old.js', 'old')]:
                (root / 'assets' / name).write_text(content)
            module['trim_assets'](root)
            self.assertEqual(sorted(p.name for p in (root / 'assets').iterdir()), ['lazy-new.js', 'main-new.js'])


if __name__ == '__main__':
    unittest.main()

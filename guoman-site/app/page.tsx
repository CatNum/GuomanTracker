import Catalog from './catalog';
import snapshot from '@/data/catalog.json';
import type { Anime } from '@/lib/catalog';
export default function Home(){return <Catalog initial={snapshot.items as Anime[]} checkedAt={snapshot.checkedAt}/>}

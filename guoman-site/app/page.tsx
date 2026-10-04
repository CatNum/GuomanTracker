import Tracker from './tracker';
import snapshot from '@/data/catalog.json';
import type { Anime } from '@/lib/catalog';
export default function Home(){return <Tracker initial={snapshot.items as Anime[]} checkedAt={snapshot.checkedAt}/>}

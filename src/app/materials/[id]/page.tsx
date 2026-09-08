import {MaterialResult} from '@/components/MaterialResult';
export default async function MaterialPage({params}:{params:Promise<{id:string}>}){return <MaterialResult id={(await params).id}/>;}

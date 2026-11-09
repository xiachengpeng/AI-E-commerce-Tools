import {createHashRouter, Navigate, Outlet, useParams} from 'react-router-dom';
import CanvasPage from '@/pages/canvas';
import CanvasProjectPage from '@/pages/canvas/project';
function ProjectRoute(){const {id}=useParams();return <CanvasProjectPage key={id} />;}
export const router=createHashRouter([
    {element:<div className="h-dvh overflow-hidden"><Outlet /></div>,children:[
        {path:'/',element:<Navigate to="/canvas" replace />},
        {path:'/canvas',element:<CanvasPage />},
        {path:'/canvas/:id',element:<ProjectRoute />},
    ]},
    {path:'*',element:<Navigate to="/canvas" replace />},
]);

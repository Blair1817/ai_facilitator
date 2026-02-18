import React from 'react';
import { Timer } from "./Timer";

export function StageTransition({ transitionText }) {
    return (
        <div className="h-screen w-screen flex justify-center items-center bg-gray-100">
            <div className="bg-white p-6 rounded-lg shadow-lg text-center border-4 border-gray-300">
                <h2 className="text-xl font-semibold mb-4">{transitionText}</h2>
                <Timer />
            </div>
        </div>
    );
};

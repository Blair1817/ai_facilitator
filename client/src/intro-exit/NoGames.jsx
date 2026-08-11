import React from "react";


export function NoGames() {
    return (
        <div className="h-full overflow-auto">
            <div className="h-screen flex items-center justify-center">
                <div className="w-92 flex flex-col items-center">
                    <h2 className="text-black-700 font-medium text-xl">No experiments available</h2>
                    <p className="mt-2 text-black text-center">Unfortunately, there are currently no experiments available. Please close this page.</p>
                </div>
            </div>
        </div>
    );
}




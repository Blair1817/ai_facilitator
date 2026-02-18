import React from "react";


export function FinishedExitCode() {

    return (
        <div className="h-full overflow-auto">
            <div className="h-screen flex items-center justify-center">
                <div className="w-92 flex flex-col items-center gap-y-10">
                    <h2 className="text-black-700 font-medium text-xl">Thank you for participating!</h2>
                    <p className="mt-2 text-black text-justify font-bold">Please submit the following code to complete the study:</p>
                    <p className="text-black text-justify font-bold text-4xl">[INSERT CODE HERE]</p>
                </div>
            </div>
        </div>
    );
}





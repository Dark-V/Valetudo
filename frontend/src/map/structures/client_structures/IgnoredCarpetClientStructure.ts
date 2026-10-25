import RestrictedZoneClientStructure from "./RestrictedZoneClientStructure";

class IgnoredCarpetClientStructure extends RestrictedZoneClientStructure {
    public static readonly TYPE = "IgnoredCarpetClientStructure";
    public carpetType?: number;
    protected activeStyle = {stroke: "rgb(6, 182, 212)", fill: "rgba(6, 182, 212, 0)"};
    protected style = {stroke: "rgb(6, 182, 212)", fill: "rgba(6, 182, 212, 0.25)"};
}

export default IgnoredCarpetClientStructure;
